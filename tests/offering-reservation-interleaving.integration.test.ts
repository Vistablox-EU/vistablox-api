import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { disclosureDocumentTypes } from "../src/modules/offering/domain/disclosure-pack.policy.js";
import { PrismaIntakeRepository } from "../src/modules/intake/repository/prisma-intake.repository.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import type { OfferingCursor } from "../src/modules/offering/repository/offering.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const farFutureIpoEndAt = new Date("2099-12-31T00:00:00.000Z");

// Issue #183: the sequential cases (a reservation arriving after a case close, after final terms are published, after
// finalization commits) are covered in intake-case-close-offering and investor-offering-repository. These tests force the
// interleavings instead: a separate connection holds the offering row lock, the competing operations queue behind it in a
// chosen order, and the lock is released so they run in exactly that order against real PostgreSQL row locking.
describe.skipIf(databaseUrl === undefined)("offering reservation interleaving PostgreSQL integration (#183)", () => {
  const suffix = randomUUID();
  const applicantAccountId = `acct_race_applicant_${suffix}`;
  const investorAccountId = `acct_race_investor_${suffix}`;
  const staffAccountId = `acct_race_staff_${suffix}`;
  const pool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  // PgBoss validates its connection string in the constructor, so it is built in beforeAll, not at describe scope.
  let boss: PgBoss;
  let intakeRepository: PrismaIntakeRepository;
  let offeringRepository: PrismaOfferingRepository;
  const disclosuresBucket = `vistablox-disclosures-race-${suffix}`;
  const caseIds: string[] = [];
  const offeringIds: string[] = [];
  const pivIds: string[] = [];

  async function createAccount(accountId: string, label: string, population: string): Promise<void> {
    const betterAuthUserId = `auth_${accountId}`;
    await pool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, label, `${accountId}@example.test`, true, population],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
  }

  async function createCase(): Promise<{ caseId: string; propertyId: string }> {
    const id = randomUUID();
    const caseId = `case_race_${id}`;
    const propertyId = `property_race_${id}`;
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "RS",
        city: "Belgrade",
        addressLine: "Race Test 1",
        ownerDeclaredValueEur: "300000.00",
      },
    });
    await database.intakeCase.create({
      data: {
        id: caseId,
        propertyId,
        applicantAccountId,
        stage: "pre_offering_open",
        ipoEndAt: farFutureIpoEndAt,
        legalExecutionEventRefs: [],
        legalDocumentRefs: [],
        appraisalDocumentRefs: [],
      },
    });
    caseIds.push(caseId);
    return { caseId, propertyId };
  }

  async function openOffering(): Promise<{ caseId: string; offeringId: string }> {
    const { caseId, propertyId } = await createCase();
    const opened = await offeringRepository.openOfferingForApprovedCase({
      caseId,
      propertyId,
      ipoValueEur: "1000.00",
      traceId: `trace_open_${suffix}`,
      openedAt: new Date(),
      openEscrowCampaign: false,
    });
    const offering = await database.offering.findUniqueOrThrow({ where: { id: opened.offeringId } });
    offeringIds.push(opened.offeringId);
    pivIds.push(offering.pivId);
    return { caseId, offeringId: opened.offeringId };
  }

  async function reserve(offeringId: string, amountEur: string) {
    return offeringRepository.createReservation({
      reservationId: `reservation_${randomUUID()}`,
      offeringId,
      accountId: investorAccountId,
      amountEur,
      disclosurePackVersionAtReservation: null,
      traceId: `trace_reserve_${suffix}`,
      createdAt: new Date(),
    });
  }

  async function reserveFunded(offeringId: string, amountEur: string): Promise<string> {
    const created = await reserve(offeringId, amountEur);
    const reservationId = created.reservation!.reservationId;
    await offeringRepository.recordMoneyEvent({
      reservationId,
      provider: "coinbase_cdp",
      providerReference: `txn_${randomUUID()}`,
      capitalState: "eurc_reserved",
      amountEur,
      amountEurc: amountEur,
      recordedAt: new Date(),
    });
    return reservationId;
  }

  async function publishCompleteDisclosurePack(offeringId: string, publishedAt: Date): Promise<void> {
    const documents = disclosureDocumentTypes.map((documentType) => ({
      documentType,
      documentRef: `documents/${offeringId}/${documentType}.pdf`,
    }));
    await database.storedDocument.createMany({
      data: documents.map(({ documentRef }) => ({
        id: `doc_${randomUUID().replaceAll("-", "")}`,
        bucket: disclosuresBucket,
        objectKey: documentRef,
        documentType: "final_terms_sheet",
        offeringId,
        contentType: "application/pdf",
        sizeBytes: BigInt(1024),
        sha256Checksum: "0".repeat(64),
        uploadStatus: "accepted",
        classification: "disclosure",
      })),
    });
    const result = await offeringRepository.publishDisclosurePack({
      offeringId,
      accountId: staffAccountId,
      documents,
      traceId: `trace_${suffix}`,
      publishedAt,
    });
    expect(result.conflict).toBeNull();
  }

  function publishFinalTerms(offeringId: string, publishedAt: Date) {
    return offeringRepository.publishFinalOfferingTerms({
      offeringId,
      accountId: staffAccountId,
      founderReviewNotes: "Target reached.",
      traceId: `trace_${suffix}`,
      publishedAt,
    });
  }

  function closeCase(caseId: string) {
    return intakeRepository.closeCase({
      outcome: "withdrawn",
      accountId: staffAccountId,
      caseId,
      traceId: `trace_close_${suffix}`,
      founderReviewNotes: "Closing the case.",
      closedAt: new Date(),
    });
  }

  async function publicOfferingIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let after: OfferingCursor | undefined;
    for (;;) {
      const page = await offeringRepository.listPublic({ limit: 200, ...(after === undefined ? {} : { after }) });
      for (const offering of page) {
        ids.add(offering.id);
      }
      const last = page.at(-1);
      if (page.length < 200 || last === undefined) {
        return ids;
      }
      after = { featured: last.featured, createdAt: last.createdAt, id: last.id };
    }
  }

  // Backends waiting, directly or through a chain of other waiters, on the given backend's locks.
  async function countWaitersBehind(holderPid: number): Promise<number> {
    const result = await pool.query<{ waiters: number }>(
      `WITH RECURSIVE waiting(pid) AS (
         SELECT $1::int
         UNION
         SELECT activity.pid FROM pg_stat_activity AS activity JOIN waiting ON waiting.pid = ANY(pg_blocking_pids(activity.pid))
       )
       SELECT (count(*) - 1)::int AS waiters FROM waiting`,
      [holderPid],
    );
    return result.rows[0]!.waiters;
  }

  async function waitForWaiters(holderPid: number, expected: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while ((await countWaitersBehind(holderPid)) < expected) {
      if (Date.now() > deadline) {
        throw new Error(`expected ${expected} backends waiting on the offering lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  // Holds the offering row lock while each operation is started and seen waiting on it, then releases the lock. PostgreSQL
  // grants a contended row lock to its waiters in arrival order, so the operations take the offering lock in array order.
  async function runInLockOrder<T extends unknown[]>(
    offeringId: string,
    operations: { [K in keyof T]: () => Promise<T[K]> },
  ): Promise<T> {
    const holder = await pool.connect();
    const started: Array<Promise<unknown>> = [];
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM offering.offerings WHERE offering_id = $1 FOR UPDATE", [offeringId]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      for (const operation of operations) {
        const promise = operation();
        // Attach a handler now so a rejection while later operations queue is not reported as unhandled.
        promise.catch(() => undefined);
        started.push(promise);
        await waitForWaiters(holderPid, started.length);
      }
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    return (await Promise.all(started)) as T;
  }

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    const kycRepository = new PrismaKycRepository(database, boss);
    intakeRepository = new PrismaIntakeRepository(database, boss, kycRepository);
    offeringRepository = new PrismaOfferingRepository(database, boss, kycRepository, { disclosuresBucket });
    await boss.start();
    await boss.createQueue("case_timers.offering_reconfirmation_window_opened");
    await boss.createQueue("case_timers.post_ipo_structuring_handoff");
    await createAccount(applicantAccountId, "Race Applicant", "customer");
    await createAccount(investorAccountId, "Race Investor", "customer");
    await createAccount(staffAccountId, "Race Staff", "staff_partner");
  }, 30_000);

  afterAll(async () => {
    // Reservations write append-only money events with RESTRICT foreign keys, so reservations, offerings, cases and accounts
    // stay behind (every id is unique per run). Positions, disclosure rows and audit rows are removed.
    await database.positionLedger.deleteMany({ where: { pivId: { in: pivIds } } });
    await database.disclosureDocument.deleteMany({ where: { disclosurePack: { offeringId: { in: offeringIds } } } });
    await database.disclosurePack.deleteMany({ where: { offeringId: { in: offeringIds } } });
    await database.storedDocument.deleteMany({ where: { offeringId: { in: offeringIds } } });
    await database.auditLog.deleteMany({ where: { resourceId: { in: [...caseIds, ...offeringIds] } } });
    await database.auditLog.deleteMany({
      where: { actorAccountId: { in: [investorAccountId, staffAccountId, applicantAccountId] } },
    });
    await Promise.all([boss.stop(), database.$disconnect(), pool.end()]);
  });

  describe("intake case close vs reservation creation", () => {
    it("a reservation queued behind the close is refused and the offering leaves the listing", async () => {
      const { caseId, offeringId } = await openOffering();
      expect(await publicOfferingIds()).toContain(offeringId);

      const [closed, late] = await runInLockOrder<[Awaited<ReturnType<typeof closeCase>>, Awaited<ReturnType<typeof reserve>>]>(
        offeringId,
        [() => closeCase(caseId), () => reserve(offeringId, "100.00")],
      );

      expect(closed).toMatchObject({ caseId, stage: "withdrawn" });
      expect(late).toEqual({ conflict: "offering_not_open", reservation: null, reused: false });
      expect(await database.reservation.count({ where: { offeringId } })).toBe(0);
      expect(await database.offering.findUniqueOrThrow({ where: { id: offeringId } })).toMatchObject({ status: "closed" });
      expect(await publicOfferingIds()).not.toContain(offeringId);
    }, 30_000);

    it("a reservation that commits just before the close is cancelled by it, not left open on a closed offering", async () => {
      const { caseId, offeringId } = await openOffering();

      const [early, closed] = await runInLockOrder<[Awaited<ReturnType<typeof reserve>>, Awaited<ReturnType<typeof closeCase>>]>(
        offeringId,
        [() => reserve(offeringId, "100.00"), () => closeCase(caseId)],
      );

      expect(early.conflict).toBeNull();
      expect(closed).toMatchObject({ caseId, stage: "withdrawn" });
      const reservationId = early.reservation!.reservationId;
      expect(await database.reservation.findUniqueOrThrow({ where: { id: reservationId } })).toMatchObject({
        reservationStage: "cancelled",
      });
      const audit = await database.auditLog.findFirstOrThrow({
        where: { resourceId: offeringId, action: "offering.closed_with_case" },
      });
      expect(audit.changes).toMatchObject({ cancelled_reservation_ids: [reservationId] });
      expect(await publicOfferingIds()).not.toContain(offeringId);
    }, 30_000);

    it("under free concurrency every reservation either is refused or ends up cancelled by the close", async () => {
      const { caseId, offeringId } = await openOffering();

      const [closed, ...reservations] = await Promise.all([
        closeCase(caseId),
        ...Array.from({ length: 8 }, () => reserve(offeringId, "100.00")),
      ]);

      expect(closed).toMatchObject({ caseId, stage: "withdrawn" });
      const accepted = reservations.filter((result) => result.conflict === null).map((result) => result.reservation!.reservationId);
      for (const result of reservations) {
        expect([null, "offering_not_open"]).toContain(result.conflict);
      }
      const audit = await database.auditLog.findFirstOrThrow({
        where: { resourceId: offeringId, action: "offering.closed_with_case" },
      });
      expect([...((audit.changes as { cancelled_reservation_ids: string[] }).cancelled_reservation_ids)].sort()).toEqual(
        [...accepted].sort(),
      );
      expect(
        await database.reservation.count({ where: { offeringId, reservationStage: { not: "cancelled" } } }),
      ).toBe(0);
      expect(await database.reservation.count({ where: { offeringId } })).toBe(accepted.length);
    }, 30_000);
  });

  describe("offering finalization vs reservation creation", () => {
    it("a reservation queued behind final-terms publication is refused as not open, before any capacity check", async () => {
      const { offeringId } = await openOffering();
      const fundedReservationId = await reserveFunded(offeringId, "1000.00");
      const publishedAt = new Date();
      await publishCompleteDisclosurePack(offeringId, publishedAt);

      const [published, late] = await runInLockOrder<
        [Awaited<ReturnType<typeof publishFinalTerms>>, Awaited<ReturnType<typeof reserve>>]
      >(offeringId, [() => publishFinalTerms(offeringId, publishedAt), () => reserve(offeringId, "100.00")]);

      expect(published.conflict).toBeNull();
      expect(published.published?.reservationsAwaitingReconfirmation).toBe(1);
      // offering_not_open, not capacity_exceeded: the final-terms check refuses the request, so it cannot slip into the
      // reconfirmation window even once capacity frees up there.
      expect(late).toEqual({ conflict: "offering_not_open", reservation: null, reused: false });
      expect(await database.reservation.findMany({ where: { offeringId }, select: { id: true, reservationStage: true } })).toEqual([
        { id: fundedReservationId, reservationStage: "awaiting_reconfirmation" },
      ]);
    }, 30_000);

    it("a reservation that reaches the lock before publication cannot over-allocate, and publication batches only the live holds", async () => {
      const { offeringId } = await openOffering();
      const fundedReservationId = await reserveFunded(offeringId, "1000.00");
      const publishedAt = new Date();
      await publishCompleteDisclosurePack(offeringId, publishedAt);

      const [early, published] = await runInLockOrder<
        [Awaited<ReturnType<typeof reserve>>, Awaited<ReturnType<typeof publishFinalTerms>>]
      >(offeringId, [() => reserve(offeringId, "100.00"), () => publishFinalTerms(offeringId, publishedAt)]);

      expect(early).toEqual({ conflict: "capacity_exceeded", reservation: null, reused: false });
      expect(published.conflict).toBeNull();
      expect(published.published).toMatchObject({ reservationsAwaitingReconfirmation: 1, reservationsCancelled: 0 });
      expect(await database.reservation.findMany({ where: { offeringId }, select: { id: true, reservationStage: true } })).toEqual([
        { id: fundedReservationId, reservationStage: "awaiting_reconfirmation" },
      ]);
    }, 30_000);

    it("a reservation queued behind the finalization commit is refused, even with capacity freed by a lapse", async () => {
      const { offeringId } = await openOffering();
      const reconfirmedReservationId = await reserveFunded(offeringId, "700.00");
      const lapsingReservationId = await reserveFunded(offeringId, "300.00");
      const publishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt);
      expect((await publishFinalTerms(offeringId, publishedAt)).conflict).toBeNull();
      const reconfirmed = await offeringRepository.reconfirmReservation({
        reservationId: reconfirmedReservationId,
        accountId: investorAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      });
      expect(reconfirmed.conflict).toBeNull();

      const commit = () =>
        offeringRepository.commitOfferingFinalization({
          offeringId,
          traceId: `trace_${suffix}`,
          finalizedAt: new Date("2026-09-10T12:00:00.000Z"),
        });
      const [committed, late] = await runInLockOrder<[Awaited<ReturnType<typeof commit>>, Awaited<ReturnType<typeof reserve>>]>(
        offeringId,
        [commit, () => reserve(offeringId, "300.00")],
      );

      expect(committed.conflict).toBeNull();
      expect(late).toEqual({ conflict: "offering_not_open", reservation: null, reused: false });
      expect(await database.offering.findUniqueOrThrow({ where: { id: offeringId } })).toMatchObject({
        status: "final_offering",
      });
      const stages = await database.reservation.findMany({ where: { offeringId }, select: { id: true, reservationStage: true } });
      expect(new Map(stages.map((stage) => [stage.id, stage.reservationStage]))).toEqual(
        new Map([
          [reconfirmedReservationId, "finalized"],
          [lapsingReservationId, "lapsed"],
        ]),
      );
    }, 30_000);
  });
});

// Issue #183 also lists two #122 gaps whose fixes have not landed. They are recorded here so the test lands with the fix.
describe("offering money-safety races pending #122", () => {
  // #122 W2: a transient 5xx must not be cached, so the client's retry with the same idempotency key re-executes.
  it.todo("an idempotent retry after a transient 5xx re-executes the handler instead of replaying the error (#122)");
  // #122 defect 3: recordMoneyEvent takes no lock shared with expireReservation. The onramp-poll path is handled in #195.
  it.todo("a money event recorded directly via recordMoneyEvent and a concurrent reservation expiry agree on one outcome (#122)");
});
