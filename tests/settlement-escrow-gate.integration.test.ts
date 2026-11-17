import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { markSettlementEscrowReady } from "./support/settlement-escrow-db.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const farFutureIpoEndAt = new Date("2099-12-31T00:00:00.000Z");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// #176, AD-286: where the settlement bundle is configured, a reservation needs
// the offering's IPO escrow campaign to have been last observed Open with its
// deadline ahead, checked again under the offering lock. Where it is dormant
// nothing about the campaign is read. Real PostgreSQL: the lock behaviour is
// the point. (Reservations leave append-only money events behind, so every id
// is suffixed and nothing is cleaned up, as in the other reservation suites.)
describe.skipIf(databaseUrl === undefined)("settlement escrow gate PostgreSQL integration (#176, AD-286)", () => {
  const suffix = randomUUID();
  const accountId = `account_escrow_gate_${suffix}`;
  const betterAuthUserId = `auth_escrow_gate_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  let boss: PgBoss;
  let gated: PrismaOfferingRepository;
  let dormant: PrismaOfferingRepository;

  type Campaign = Parameters<typeof markSettlementEscrowReady>[2];

  async function createOffering(campaign: Campaign | null): Promise<{ offeringId: string; pivId: string }> {
    const id = randomUUID();
    const propertyId = `property_escrow_gate_${id}`;
    const caseId = `case_escrow_gate_${id}`;
    const pivId = `piv_escrow_gate_${id}`;
    const offeringId = `offering_escrow_gate_${id}`;
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "DE",
        city: "Leipzig",
        addressLine: "Escrow Gate Test 1",
        ownerDeclaredValueEur: "600000.00",
      },
    });
    await database.intakeCase.create({
      data: {
        id: caseId,
        propertyId,
        applicantAccountId: accountId,
        stage: "approved_for_final_offering",
        legalExecutionEventRefs: [],
        legalDocumentRefs: [],
        appraisalDocumentRefs: [],
        ipoEndAt: farFutureIpoEndAt,
      },
    });
    await database.piv.create({ data: { id: pivId, propertyId, caseId } });
    if (campaign !== null) await markSettlementEscrowReady(database, pivId, campaign);
    await database.offering.create({
      data: {
        id: offeringId,
        pivId,
        minimumRaiseEur: "1000.00",
        targetRaiseEur: "1000.00",
        status: "pre_offering",
      },
    });
    return { offeringId, pivId };
  }

  function reserve(repository: PrismaOfferingRepository, offeringId: string, createdAt = new Date()) {
    return repository.createReservation({
      reservationId: `reservation_${randomUUID()}`,
      offeringId,
      accountId,
      amountEur: "100.00",
      disclosurePackVersionAtReservation: null,
      traceId: `trace_${suffix}`,
      createdAt,
    });
  }

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    const kyc = new PrismaKycRepository(database, boss);
    gated = new PrismaOfferingRepository(database, boss, kyc, { settlementEscrowGated: true });
    dormant = new PrismaOfferingRepository(database, boss, kyc);
    await boss.start();
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Escrow Gate Investor", `escrow-gate-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
  });

  afterAll(async () => {
    await database.auditLog.deleteMany({ where: { resourceType: "reservation", actorAccountId: accountId } });
    await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
  });

  describe("createReservation where the settlement bundle is configured", () => {
    it("refuses an offering with no recorded campaign, and writes nothing", async () => {
      const { offeringId } = await createOffering(null);

      const result = await reserve(gated, offeringId);

      expect(result).toEqual({ reservation: null, conflict: "settlement_escrow_not_ready", reused: false });
      expect(await database.reservation.count({ where: { offeringId } })).toBe(0);
    });

    it("accepts a campaign last observed Open with its deadline ahead", async () => {
      const { offeringId } = await createOffering({ state: "open" });

      const result = await reserve(gated, offeringId);

      expect(result.conflict).toBeNull();
      expect(await database.reservation.count({ where: { offeringId } })).toBe(1);
    });

    it.each(["successful", "failed", "not_opened"] as const)(
      "refuses a campaign last observed %s, though a row exists",
      async (state) => {
        const { offeringId } = await createOffering({ state });

        const result = await reserve(gated, offeringId);

        expect(result).toEqual({ reservation: null, conflict: "settlement_escrow_not_ready", reused: false });
        expect(await database.reservation.count({ where: { offeringId } })).toBe(0);
      },
    );

    it("refuses an Open observation whose deadline has passed at the reservation's own time, nobody having re-read it", async () => {
      const deadlineAt = new Date("2026-09-30T12:00:00.000Z");
      const { offeringId } = await createOffering({ state: "open", deadlineAt });

      const atDeadline = await reserve(gated, offeringId, deadlineAt);
      const after = await reserve(gated, offeringId, new Date(deadlineAt.getTime() + 60_000));
      const justBefore = await reserve(gated, offeringId, new Date(deadlineAt.getTime() - 1));

      expect(atDeadline).toEqual({ reservation: null, conflict: "settlement_escrow_not_ready", reused: false });
      expect(after).toEqual({ reservation: null, conflict: "settlement_escrow_not_ready", reused: false });
      expect(justBefore.conflict).toBeNull();
    });

    it("reads the observation after it has the offering lock: an observation that goes stale while the request waits for the lock still refuses it", async () => {
      const { offeringId, pivId } = await createOffering({ state: "open" });
      const holder = await authPool.connect();
      try {
        await holder.query("BEGIN");
        const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await holder.query("SELECT 1 FROM offering.offerings WHERE offering_id = $1 FOR UPDATE", [offeringId]);

        // The request queues behind the offering lock, having not read the campaign yet.
        const attempt = reserve(gated, offeringId);
        await waitForWaiters(holderPid);

        // Meanwhile the campaign is observed resolved and that is committed.
        await database.$executeRaw`
          UPDATE settlement.ipo_escrow_campaigns SET observed_state = 'successful', observed_at = now() WHERE piv_id = ${pivId}
        `;
        await holder.query("COMMIT");

        expect(await attempt).toEqual({ reservation: null, conflict: "settlement_escrow_not_ready", reused: false });
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        holder.release();
      }
    });

    it("reads the campaign row with a lock, so a writer of that row is waited for and its committed state is what decides", async () => {
      const { offeringId, pivId } = await createOffering({ state: "open" });
      const writer = await authPool.connect();
      try {
        await writer.query("BEGIN");
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
        await writer.query("SELECT 1 FROM settlement.ipo_escrow_campaigns WHERE piv_id = $1 FOR UPDATE", [pivId]);
        await writer.query("UPDATE settlement.ipo_escrow_campaigns SET observed_state = 'failed' WHERE piv_id = $1", [pivId]);

        const attempt = reserve(gated, offeringId);
        await waitForWaiters(writerPid);
        await writer.query("COMMIT");

        expect(await attempt).toEqual({ reservation: null, conflict: "settlement_escrow_not_ready", reused: false });
        expect(await database.reservation.count({ where: { offeringId } })).toBe(0);
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        writer.release();
      }
    });
  });

  describe("createReservation where the settlement bundle is dormant (AD-234)", () => {
    it("does not look for a campaign: an offering with none takes the reservation", async () => {
      const { offeringId } = await createOffering(null);

      const result = await reserve(dormant, offeringId);

      expect(result.conflict).toBeNull();
    });

    it("does not read a campaign row at all: a failed observation is no reason to refuse", async () => {
      const { offeringId } = await createOffering({ state: "failed" });

      const result = await reserve(dormant, offeringId);

      expect(result.conflict).toBeNull();
    });
  });

  describe("getInvestorDetail", () => {
    it("reports the gate and the last observation where the bundle is configured", async () => {
      const none = await createOffering(null);
      const deadlineAt = new Date("2099-01-01T00:00:00.000Z");
      const open = await createOffering({ state: "open", deadlineAt });
      const failed = await createOffering({ state: "failed", deadlineAt });

      expect(await gated.getInvestorDetail({ offeringId: none.offeringId, accountId })).toMatchObject({
        settlementEscrow: { gated: true, campaign: null },
      });
      expect(await gated.getInvestorDetail({ offeringId: open.offeringId, accountId })).toMatchObject({
        settlementEscrow: { gated: true, campaign: { state: "open", deadlineAt } },
      });
      expect(await gated.getInvestorDetail({ offeringId: failed.offeringId, accountId })).toMatchObject({
        settlementEscrow: { gated: true, campaign: { state: "failed", deadlineAt } },
      });
    });

    it("reports no gate where the bundle is dormant, whatever is recorded", async () => {
      const none = await createOffering(null);
      const failed = await createOffering({ state: "failed" });

      expect(await dormant.getInvestorDetail({ offeringId: none.offeringId, accountId })).toMatchObject({
        settlementEscrow: { gated: false },
      });
      expect(await dormant.getInvestorDetail({ offeringId: failed.offeringId, accountId })).toMatchObject({
        settlementEscrow: { gated: false },
      });
    });
  });

  // Some backend is blocked behind the holder's locks: the request is queued
  // at the lock, not yet past it.
  async function waitForWaiters(holderPid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const result = await authPool.query<{ waiters: number }>(
        `SELECT count(*)::int AS waiters FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      );
      if ((result.rows[0]?.waiters ?? 0) >= 1) return;
      if (Date.now() > deadline) throw new Error("the request never queued behind the lock");
      await sleep(10);
    }
  }
});
