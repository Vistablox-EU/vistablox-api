import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { PrismaOnrampPaymentRepository } from "../src/modules/offering/repository/prisma-onramp-payment.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "late provider payments PostgreSQL integration (issue #168)",
  () => {
    const suffix = randomUUID();
    const accountId = `account_late_${suffix}`;
    const betterAuthUserId = `auth_late_${suffix}`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // PgBoss validates its connection string eagerly, so build it in beforeAll.
    let boss: PgBoss;
    let offerings: PrismaOfferingRepository;
    const payments = new PrismaOnrampPaymentRepository(database);
    let offeringId: string;

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      offerings = new PrismaOfferingRepository(database, boss, new PrismaKycRepository(database, boss));
      await boss.start();
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserId, "Late Payment Investor", `late-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId } });
      const propertyId = `property_late_${suffix}`;
      const caseId = `case_late_${suffix}`;
      const pivId = `piv_late_${suffix}`;
      offeringId = `offering_late_${suffix}`;
      await database.property.create({
        data: { id: propertyId, countryCode: "DE", city: "Leipzig", addressLine: "Late Payment 1", ownerDeclaredValueEur: "600000.00" },
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
          ipoEndAt: new Date("2099-12-31T00:00:00.000Z"),
        },
      });
      await database.piv.create({ data: { id: pivId, propertyId, caseId } });
      await database.offering.create({
        data: { id: offeringId, pivId, minimumRaiseEur: "100000.00", targetRaiseEur: "100000.00", status: "pre_offering" },
      });
    });

    afterAll(async () => {
      // money_events is append-only with an ON DELETE RESTRICT key to
      // reservations, so like the other offering integration suites the
      // uniquely suffixed fixtures are left behind; only audit rows go.
      await database.auditLog.deleteMany({ where: { resourceType: "reservation", resourceId: { contains: suffix } } });
      await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
    });

    async function reservationAwaitingPurchase(options: { createdAt: Date; lapse: boolean }): Promise<string> {
      const reservationId = `reservation_late_${suffix}_${randomUUID()}`;
      await offerings.createReservation({
        reservationId,
        offeringId,
        accountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: options.createdAt,
      });
      await offerings.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: `channel_${reservationId}`,
        capitalState: "eurc_purchase_pending",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(options.createdAt.getTime() + 60_000),
      });
      if (options.lapse) {
        expect(
          await offerings.expireReservation({
            reservationId,
            traceId: `trace_${suffix}`,
            expiredAt: new Date(options.createdAt.getTime() + 16 * 60_000),
          }),
        ).toBe(true);
      }
      return reservationId;
    }

    function outcome(reservationId: string, providerReference: string, kind: "funded" | "uncovered_success" | "failed") {
      return {
        reservationId,
        provider: "coinbase_cdp",
        providerReference,
        outcome: kind,
        amountEur: "1000.00",
        purchaseCurrency: "EURC",
        purchaseAmount: kind === "funded" ? "950.000000" : "10.000000",
        recordedAt: new Date(Date.now() + 120_000),
        traceId: `trace_${suffix}`,
      };
    }

    it("still appends a money event while the reservation is initiated", async () => {
      const reservationId = await reservationAwaitingPurchase({ createdAt: new Date(), lapse: false });

      const result = await payments.recordOnrampOutcome(outcome(reservationId, `txn_${reservationId}`, "funded"));

      expect(result).toEqual({ kind: "money_event_recorded", capitalState: "eurc_reserved" });
      const events = await database.moneyEvent.findMany({ where: { reservationId }, orderBy: { recordedAt: "asc" } });
      expect(events.map((event) => event.capitalState)).toEqual(["initiated", "eurc_purchase_pending", "eurc_reserved"]);
      expect(await database.latePayment.count({ where: { reservationId } })).toBe(0);
    });

    it("holds a payment on a lapsed reservation for review, idempotently, without touching money_events or the stage", async () => {
      const reservationId = await reservationAwaitingPurchase({ createdAt: new Date(), lapse: true });
      const providerReference = `txn_${reservationId}`;

      const first = await payments.recordOnrampOutcome(outcome(reservationId, providerReference, "funded"));
      const second = await payments.recordOnrampOutcome(outcome(reservationId, providerReference, "funded"));

      expect(first).toMatchObject({ kind: "late_payment_held", newlyHeld: true, reservationStage: "lapsed" });
      expect(second).toEqual({ ...first, newlyHeld: false });
      const held = await database.latePayment.findMany({ where: { reservationId } });
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({
        provider: "coinbase_cdp",
        providerReference,
        reservationStageAtDetection: "lapsed",
        purchaseCurrency: "EURC",
        coversReservation: true,
        reviewStatus: "pending_review",
      });
      expect(held[0]?.reservedAmountEur.toFixed(2)).toBe("1000.00");
      expect(held[0]?.purchaseAmount.toFixed(6)).toBe("950.000000");
      const events = await database.moneyEvent.findMany({ where: { reservationId } });
      expect(events.map((event) => event.capitalState).sort()).toEqual(["eurc_purchase_pending", "initiated"]);
      expect((await database.reservation.findUniqueOrThrow({ where: { id: reservationId } })).reservationStage).toBe("lapsed");
      const audits = await database.auditLog.findMany({ where: { resourceId: reservationId, action: "offering.late_payment_held" } });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.changes).toMatchObject({ late_payment_id: held[0]?.id, covers_reservation: true, reservation_stage: "lapsed" });
    });

    it("holds a non-covering late success too, and ignores a late failure", async () => {
      const reservationId = await reservationAwaitingPurchase({ createdAt: new Date(), lapse: true });

      expect(await payments.recordOnrampOutcome(outcome(reservationId, `txn_failed_${reservationId}`, "failed"))).toEqual({
        kind: "ignored",
        reservationStage: "lapsed",
      });
      expect(await database.latePayment.count({ where: { reservationId } })).toBe(0);

      const held = await payments.recordOnrampOutcome(outcome(reservationId, `txn_small_${reservationId}`, "uncovered_success"));
      expect(held).toMatchObject({ kind: "late_payment_held", newlyHeld: true });
      expect((await database.latePayment.findFirstOrThrow({ where: { reservationId } })).coversReservation).toBe(false);
    });

    it("watches lapsed reservations inside the window until a late payment is held", async () => {
      const now = Date.now();
      const watched = await reservationAwaitingPurchase({ createdAt: new Date(now), lapse: true });
      const tooOld = await reservationAwaitingPurchase({ createdAt: new Date(now - 10 * 24 * 60 * 60_000), lapse: true });
      const stillInitiated = await reservationAwaitingPurchase({ createdAt: new Date(now), lapse: false });

      const since = new Date(now - 7 * 24 * 60 * 60_000);
      const before = (await payments.listLatePaymentWatchReservations({ since })).map((row) => row.reservationId);
      expect(before).toContain(watched);
      expect(before).not.toContain(tooOld);
      expect(before).not.toContain(stillInitiated);
      expect((await payments.listLatePaymentWatchReservations({ since })).find((row) => row.reservationId === watched)).toEqual({
        reservationId: watched,
        accountId,
        amountEur: "1000.00",
        reservationStage: "lapsed",
      });

      await payments.recordOnrampOutcome(outcome(watched, `txn_${watched}`, "funded"));
      const after = (await payments.listLatePaymentWatchReservations({ since })).map((row) => row.reservationId);
      expect(after).not.toContain(watched);
    });

    it("lists held late payments newest first for staff, with the reservation's current stage", async () => {
      const reservationId = await reservationAwaitingPurchase({ createdAt: new Date(), lapse: true });
      await payments.recordOnrampOutcome(outcome(reservationId, `txn_list_${reservationId}`, "funded"));

      const rows = await payments.listLatePayments({ limit: 100, reviewStatus: "pending_review" });
      const row = rows.find((candidate) => candidate.reservationId === reservationId);
      expect(row).toMatchObject({
        offeringId,
        accountId,
        providerReference: `txn_list_${reservationId}`,
        reservationStageAtDetection: "lapsed",
        currentReservationStage: "lapsed",
        reservedAmountEur: "1000.00",
        purchaseAmount: "950.000000",
        coversReservation: true,
      });
      const ids = rows.map((candidate) => candidate.latePaymentId);
      expect(ids).toEqual([...ids].sort().reverse());
      if (row !== undefined) {
        const after = await payments.listLatePayments({ limit: 100, after: row.latePaymentId });
        expect(after.every((candidate) => candidate.latePaymentId < row.latePaymentId)).toBe(true);
      }
    });

    it("rejects a late payment row with a stage of 'initiated' at the database", async () => {
      const reservationId = await reservationAwaitingPurchase({ createdAt: new Date(), lapse: false });
      await expect(
        database.latePayment.create({
          data: {
            id: `late_payment_${randomUUID()}`,
            reservationId,
            provider: "coinbase_cdp",
            providerReference: `txn_bad_${reservationId}`,
            reservationStageAtDetection: "initiated",
            reservedAmountEur: "1000.00",
            purchaseCurrency: "EURC",
            purchaseAmount: "950.000000",
            coversReservation: true,
            detectedAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });
  },
);
