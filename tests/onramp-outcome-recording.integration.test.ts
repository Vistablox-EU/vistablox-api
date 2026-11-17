import { randomUUID } from "node:crypto";

import pino from "pino";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import { ReconcileOnrampWebhookService } from "../src/modules/offering/application/coinbase-onramp-webhook.service.js";
import type { OtherStageOnrampOutcome } from "../src/modules/offering/application/other-stage-onramp-outcome.js";
import { PollOnrampTransactionsService } from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import type { RecordOnrampOutcomeInput } from "../src/modules/offering/repository/reservation.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const farFutureIpoEndAt = new Date("2099-12-31T00:00:00.000Z");
const webhookQueue = "provider_events.coinbase_onramp_webhook";

// Real PostgreSQL: the single onramp recording method (the reservation row
// lock, the latest money event read after it, the dedupe per provider
// transaction and state, the stage check) and the receipt-plus-job
// transaction. The unit tests of the policy pin the matrix; these pin that the
// database enforces it under concurrency.
describe.skipIf(databaseUrl === undefined)("onramp outcome recording PostgreSQL integration (AD-289)", () => {
  const suffix = randomUUID();
  const accountId = `account_onramp_${suffix}`;
  const betterAuthUserId = `auth_onramp_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  // PgBoss validates its connection string in the constructor, so it is built
  // in beforeAll: the describe body runs even when skipIf skips every test.
  let boss: PgBoss;
  let repository: PrismaOfferingRepository;
  let kycRepository: PrismaKycRepository;

  async function createOffering(): Promise<string> {
    const id = randomUUID();
    const propertyId = `property_onramp_${id}`;
    const caseId = `case_onramp_${id}`;
    const pivId = `piv_onramp_${id}`;
    const offeringId = `offering_onramp_${id}`;
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "DE",
        city: "Leipzig",
        addressLine: "Onramp Recording Test 1",
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
    await database.offering.create({
      data: { id: offeringId, pivId, minimumRaiseEur: "100000.00", targetRaiseEur: "100000.00", status: "pre_offering" },
    });
    return offeringId;
  }

  // A reservation as createReservation leaves it once the onramp session
  // exists: stage 'initiated', latest money event eurc_purchase_pending.
  async function newReservation(amountEur = "100.00"): Promise<{ reservationId: string; start: number }> {
    const reservationId = `reservation_${randomUUID()}`;
    const start = Date.now();
    await repository.createReservation({
      reservationId,
      offeringId: await createOffering(),
      accountId,
      amountEur,
      disclosurePackVersionAtReservation: null,
      traceId: `trace_${suffix}`,
      createdAt: new Date(start),
    });
    await repository.recordMoneyEvent({
      reservationId,
      provider: "coinbase_cdp",
      providerReference: "channel_01",
      capitalState: "eurc_purchase_pending",
      amountEur,
      amountEurc: null,
      recordedAt: new Date(start + 1_000),
    });
    return { reservationId, start };
  }

  function outcome(
    reservationId: string,
    capitalState: "eurc_reserved" | "purchase_failed",
    transactionId: string,
    recordedAt: number,
  ): RecordOnrampOutcomeInput {
    return {
      reservationId,
      provider: "coinbase_cdp",
      providerReference: transactionId,
      capitalState,
      amountEur: "100.00",
      amountEurc: capitalState === "eurc_reserved" ? "99.000000" : null,
      recordedAt: new Date(recordedAt),
    };
  }

  async function history(reservationId: string): Promise<Array<[string, string | null]>> {
    const events = await database.moneyEvent.findMany({
      where: { reservationId },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
    });
    return events.map((event) => [event.capitalState, event.providerReference]);
  }

  // Holds the reservation row lock on a separate connection so the callbacks
  // below queue behind it in a known order (the technique of #196's tests).
  async function withReservationLockHeld<T>(
    reservationId: string,
    run: (queue: (start: () => Promise<unknown>) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const holder = await authPool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM offering.reservations WHERE reservation_id = $1 FOR UPDATE", [reservationId]);
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      const waiting: number[] = [];
      const blockedBy = async (pids: number[]) =>
        (
          await authPool.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) && $1::int[]",
            [pids],
          )
        ).rows.map((row) => row.pid);
      const queue = async (start: () => Promise<unknown>): Promise<void> => {
        void start().catch(() => undefined);
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const blocked = await blockedBy([holderPid, ...waiting]);
          const fresh = blocked.filter((pid) => !waiting.includes(pid));
          if (fresh.length === 1) {
            waiting.push(fresh[0]!);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("timed out waiting for the lock queue");
      };
      try {
        return await run(queue);
      } finally {
        await holder.query("COMMIT");
      }
    } finally {
      holder.release();
    }
  }

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    kycRepository = new PrismaKycRepository(database, boss);
    repository = new PrismaOfferingRepository(database, boss, kycRepository);
    await boss.start();
    await boss.createQueue(webhookQueue);
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Onramp Recording Investor", `onramp-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
  });

  afterAll(async () => {
    // money_events and onramp_webhook_receipts are append-only and the money
    // events hold foreign keys into the reservations, so what the tests create
    // stays behind, uniquely suffixed per run (the same as the reservation
    // creation tests). Only the audit rows are removed.
    await database.auditLog.deleteMany({ where: { resourceType: "reservation" } });
    await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
  });

  describe("recordOnrampOutcome", () => {
    it("records a failure once however often it is reported, so the poll cannot repeat purchase_failed every minute", async () => {
      const { reservationId, start } = await newReservation();

      expect(await repository.recordOnrampOutcome(outcome(reservationId, "purchase_failed", "txn_a", start + 2_000))).toEqual({
        status: "recorded",
      });
      for (let poll = 0; poll < 3; poll += 1) {
        expect(
          await repository.recordOnrampOutcome(outcome(reservationId, "purchase_failed", "txn_a", start + 3_000 + poll)),
        ).toEqual({ status: "duplicate" });
      }

      expect(await history(reservationId)).toEqual([
        ["initiated", null],
        ["eurc_purchase_pending", "channel_01"],
        ["purchase_failed", "txn_a"],
      ]);
    });

    it("does not fail a retry with the old failed transaction, and records the retry's own failure", async () => {
      const { reservationId, start } = await newReservation();
      await repository.recordOnrampOutcome(outcome(reservationId, "purchase_failed", "txn_a", start + 2_000));
      // The investor retries: a new session puts the reservation back to pending.
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "channel_02",
        capitalState: "eurc_purchase_pending",
        amountEur: "100.00",
        amountEurc: null,
        recordedAt: new Date(start + 3_000),
      });

      // Coinbase's list still shows the first attempt as failed.
      expect(await repository.recordOnrampOutcome(outcome(reservationId, "purchase_failed", "txn_a", start + 4_000))).toEqual({
        status: "duplicate",
      });
      expect((await history(reservationId)).at(-1)).toEqual(["eurc_purchase_pending", "channel_02"]);

      expect(await repository.recordOnrampOutcome(outcome(reservationId, "purchase_failed", "txn_b", start + 5_000))).toEqual({
        status: "recorded",
      });
      expect((await history(reservationId)).at(-1)).toEqual(["purchase_failed", "txn_b"]);
    });

    it("records a funding once under concurrent webhook and poll delivery, and a late failure never lands over it", async () => {
      const { reservationId, start } = await newReservation();
      await repository.recordOnrampOutcome(outcome(reservationId, "purchase_failed", "txn_a", start + 2_000));

      const funded = outcome(reservationId, "eurc_reserved", "txn_x", start + 4_000);
      const results = await Promise.all([
        repository.recordOnrampOutcome(funded),
        repository.recordOnrampOutcome(funded),
        repository.recordOnrampOutcome(funded),
        repository.recordOnrampOutcome(funded),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(["duplicate", "duplicate", "duplicate", "recorded"]);
      expect(await history(reservationId)).toEqual([
        ["initiated", null],
        ["eurc_purchase_pending", "channel_01"],
        ["purchase_failed", "txn_a"],
        ["eurc_reserved", "txn_x"],
      ]);

      // Funded money is never written over: not by an unfunded event (#201's guard), not by a second funding.
      expect(await repository.recordOnrampOutcome(outcome(reservationId, "purchase_failed", "txn_b", start + 5_000))).toEqual({
        status: "already_funded",
      });
      expect(await repository.recordOnrampOutcome(outcome(reservationId, "eurc_reserved", "txn_y", start + 6_000))).toEqual({
        status: "already_funded",
      });
      expect(await database.moneyEvent.count({ where: { reservationId } })).toBe(4);
    });

    it("answers other_stage for a lapsed or cancelled reservation and writes nothing", async () => {
      const lapsed = await newReservation();
      expect(
        await repository.expireReservation({
          reservationId: lapsed.reservationId,
          traceId: `trace_${suffix}`,
          expiredAt: new Date(lapsed.start + 2_000),
        }),
      ).toBe(true);
      const cancelled = await newReservation();
      await database.reservation.update({ where: { id: cancelled.reservationId }, data: { reservationStage: "cancelled" } });

      expect(
        await repository.recordOnrampOutcome(outcome(lapsed.reservationId, "eurc_reserved", "txn_late", lapsed.start + 3_000)),
      ).toEqual({ status: "other_stage", reservationStage: "lapsed", latestCapitalState: "eurc_purchase_pending" });
      expect(
        await repository.recordOnrampOutcome(outcome(cancelled.reservationId, "purchase_failed", "txn_late", cancelled.start + 3_000)),
      ).toEqual({ status: "other_stage", reservationStage: "cancelled", latestCapitalState: "eurc_purchase_pending" });

      expect(await database.moneyEvent.count({ where: { reservationId: lapsed.reservationId } })).toBe(2);
      expect(await database.moneyEvent.count({ where: { reservationId: cancelled.reservationId } })).toBe(2);
      expect(await database.reservation.findUnique({ where: { id: lapsed.reservationId } })).toMatchObject({
        reservationStage: "lapsed",
      });
    });

    it("keeps evidence that is already on file a duplicate after the reservation moved on, so it never reads as late", async () => {
      const { reservationId, start } = await newReservation();
      await repository.recordOnrampOutcome(outcome(reservationId, "eurc_reserved", "txn_x", start + 2_000));
      await database.reservation.update({ where: { id: reservationId }, data: { reservationStage: "awaiting_reconfirmation" } });

      expect(await repository.recordOnrampOutcome(outcome(reservationId, "eurc_reserved", "txn_x", start + 3_000))).toEqual({
        status: "duplicate",
      });
      expect(await repository.recordOnrampOutcome(outcome(reservationId, "eurc_reserved", "txn_other", start + 4_000))).toEqual({
        status: "other_stage",
        reservationStage: "awaiting_reconfirmation",
        latestCapitalState: "eurc_reserved",
      });
    });

    it("answers not_awaiting_purchase before a purchase was ever started, and unknown_reservation for an id it does not have", async () => {
      const reservationId = `reservation_${randomUUID()}`;
      const start = Date.now();
      await repository.createReservation({
        reservationId,
        offeringId: await createOffering(),
        accountId,
        amountEur: "100.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(start),
      });

      expect(await repository.recordOnrampOutcome(outcome(reservationId, "eurc_reserved", "txn_x", start + 1_000))).toEqual({
        status: "not_awaiting_purchase",
        latestCapitalState: "initiated",
      });
      expect(
        await repository.recordOnrampOutcome(outcome(`reservation_${randomUUID()}`, "eurc_reserved", "txn_x", start + 1_000)),
      ).toEqual({ status: "unknown_reservation" });
      expect(await database.moneyEvent.count({ where: { reservationId } })).toBe(1);
    });

    it("records the same transaction once when two recordings queue behind the reservation lock", async () => {
      const { reservationId, start } = await newReservation();
      const funded = outcome(reservationId, "eurc_reserved", "txn_x", start + 60_000);

      const { first, second } = await withReservationLockHeld(reservationId, async (queue) => {
        const first = repository.recordOnrampOutcome(funded);
        await queue(() => first);
        const second = repository.recordOnrampOutcome({ ...funded, recordedAt: new Date(start + 61_000) });
        await queue(() => second);
        return { first, second };
      });

      expect([(await first).status, (await second).status]).toEqual(["recorded", "duplicate"]);
      expect(await database.moneyEvent.count({ where: { reservationId, capitalState: "eurc_reserved" } })).toBe(1);
    });

    it("lets a queued expiry win and then refuses the funding as other_stage, never money on a lapsed reservation", async () => {
      const { reservationId, start } = await newReservation();

      const { expired, recording } = await withReservationLockHeld(reservationId, async (queue) => {
        const expiry = repository.expireReservation({
          reservationId,
          traceId: `trace_${suffix}`,
          expiredAt: new Date(start + 16 * 60_000),
        });
        await queue(() => expiry);
        const record = repository.recordOnrampOutcome(outcome(reservationId, "eurc_reserved", "txn_x", start + 60_000));
        await queue(() => record);
        return {
          get expired() {
            return expiry;
          },
          get recording() {
            return record;
          },
        };
      });

      expect(await expired).toBe(true);
      expect(await recording).toEqual({
        status: "other_stage",
        reservationStage: "lapsed",
        latestCapitalState: "eurc_purchase_pending",
      });
      expect(await database.moneyEvent.count({ where: { reservationId, capitalState: "eurc_reserved" } })).toBe(0);
    });

    it("lets a queued funding win and then refuses the expiry, never a lapsed reservation holding money", async () => {
      const { reservationId, start } = await newReservation();

      const { expired, recording } = await withReservationLockHeld(reservationId, async (queue) => {
        const record = repository.recordOnrampOutcome(outcome(reservationId, "eurc_reserved", "txn_x", start + 60_000));
        await queue(() => record);
        const expiry = repository.expireReservation({
          reservationId,
          traceId: `trace_${suffix}`,
          expiredAt: new Date(start + 16 * 60_000),
        });
        await queue(() => expiry);
        return {
          get expired() {
            return expiry;
          },
          get recording() {
            return record;
          },
        };
      });

      expect(await recording).toEqual({ status: "recorded" });
      expect(await expired).toBe(false);
      expect((await database.reservation.findUnique({ where: { id: reservationId } }))?.reservationStage).toBe("initiated");
      expect((await history(reservationId)).at(-1)).toEqual(["eurc_reserved", "txn_x"]);
    });
  });

  describe("findReservationForOnrampReconciliation", () => {
    it("finds a reservation in any stage, and null for one that does not exist", async () => {
      const { reservationId, start } = await newReservation("250.00");
      await repository.expireReservation({
        reservationId,
        traceId: `trace_${suffix}`,
        expiredAt: new Date(start + 2_000),
      });

      expect(await repository.findReservationForOnrampReconciliation(reservationId)).toEqual({
        reservationId,
        accountId,
        amountEur: "250.00",
        reservationStage: "lapsed",
      });
      expect(await repository.findReservationForOnrampReconciliation(`reservation_${randomUUID()}`)).toBeNull();
    });
  });

  describe("the poll and the webhook job over the real recording method", () => {
    const coinbaseWith = (transactions: OnrampTransactionSummary[]): CoinbaseCdpClient => ({
      createOnrampSessionToken: vi.fn(),
      buildOnrampUrl: vi.fn(),
      listBuyTransactions: vi.fn().mockResolvedValue({ transactions, nextPageKey: null }),
    });
    const transaction = (overrides: Partial<OnrampTransactionSummary>): OnrampTransactionSummary => ({
      transactionId: "txn_a",
      status: "failed",
      walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      purchaseCurrency: "EURC",
      purchaseAmountValue: "99.000000",
      paymentTotalCurrency: "EUR",
      paymentTotalValue: "100.00",
      txHash: "0xabc",
      createdAt: new Date("2026-11-17T10:00:00.000Z"),
      completedAt: null,
      ...overrides,
    });
    const silent = pino({ level: "silent" });

    it("writes one purchase_failed row however many minutes the poll lists the failed reservation, then funds it from the retry", async () => {
      const { reservationId, start } = await newReservation();
      // Each write lands after the one before it, as it would minute by minute.
      let tick = 10_000;
      const clock = () => new Date(start + (tick += 1_000));
      const failed = coinbaseWith([transaction({ status: "failed" })]);
      const poll = new PollOnrampTransactionsService(repository, failed, silent, clock);

      // The poll lists every initiated reservation awaiting a purchase, so only
      // this one is checked here by looking at its own history afterwards.
      for (let minute = 0; minute < 3; minute += 1) await poll.reconcileReservation({ reservationId, amountEur: "100.00" }, "trace_01");
      expect((await history(reservationId)).filter(([state]) => state === "purchase_failed")).toEqual([["purchase_failed", "txn_a"]]);

      const funded = new PollOnrampTransactionsService(
        repository,
        coinbaseWith([transaction({ status: "failed" }), transaction({ transactionId: "txn_b", status: "success" })]),
        silent,
        clock,
      );
      expect(await funded.reconcileReservation({ reservationId, amountEur: "100.00" }, "trace_01")).toMatchObject({
        status: "resolved",
        recording: { status: "recorded" },
      });
      expect((await history(reservationId)).at(-1)).toEqual(["eurc_reserved", "txn_b"]);
    });

    it("hands a lapsed reservation's late success to the seam through the webhook job, recording nothing", async () => {
      const { reservationId, start } = await newReservation();
      await repository.expireReservation({ reservationId, traceId: `trace_${suffix}`, expiredAt: new Date(start + 2_000) });
      const handled: OtherStageOnrampOutcome[] = [];
      const poller = new PollOnrampTransactionsService(
        repository,
        coinbaseWith([transaction({ transactionId: "txn_late", status: "success" })]),
        silent,
        () => new Date("2026-11-17T12:00:00.000Z"),
        { handleOtherStageOutcome: async (late) => void handled.push(late) },
      );
      const job = new ReconcileOnrampWebhookService(repository, poller);

      const result = await job.execute({
        reservationId,
        eventId: `evt_${randomUUID()}`,
        eventType: "onramp.transaction.success",
        trace_id: "trace_job",
      });

      expect(result).toMatchObject({ status: "resolved", capital_state: "eurc_reserved", recording: "other_stage" });
      expect(handled).toEqual([
        {
          reservationId,
          reservationStage: "lapsed",
          latestCapitalState: "eurc_purchase_pending",
          providerTransactionId: "txn_late",
          txHash: "0xabc",
          destinationWallet: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
          amount: "99.000000",
          asset: "EURC",
          state: "eurc_reserved",
          observedAt: new Date("2026-11-17T12:00:00.000Z"),
          traceId: "trace_job",
        },
      ]);
      expect(await database.moneyEvent.count({ where: { reservationId, capitalState: "eurc_reserved" } })).toBe(0);
    });
  });

  describe("receiveOnrampWebhook", () => {
    const receiptFor = (eventId: string, partnerUserRef = `reservation_${randomUUID()}`) => ({
      eventId,
      eventType: "onramp.transaction.success",
      transactionId: "txn_01",
      txHash: "0xabc",
      partnerUserRef,
    });
    const jobsFor = async (eventId: string) =>
      (
        await authPool.query<{ data: Record<string, unknown> }>(
          "SELECT data FROM pgboss.job WHERE name = $1 AND data->>'eventId' = $2",
          [webhookQueue, eventId],
        )
      ).rows.map((row) => row.data);
    const receiptsFor = async (eventId: string) =>
      (await authPool.query("SELECT * FROM money.onramp_webhook_receipts WHERE event_id = $1", [eventId])).rows;

    it("writes the receipt and enqueues the job, carrying ids and nothing else", async () => {
      const eventId = `evt_${randomUUID()}`;
      const receipt = receiptFor(eventId);

      expect(await repository.receiveOnrampWebhook(receipt, "trace_01")).toBe("enqueued");

      const rows = await receiptsFor(eventId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event_id: eventId,
        event_type: "onramp.transaction.success",
        transaction_id: "txn_01",
        tx_hash: "0xabc",
        partner_user_ref: receipt.partnerUserRef,
      });
      expect(Object.keys(rows[0]).sort()).toEqual(
        ["event_id", "event_type", "onramp_webhook_receipt_id", "partner_user_ref", "received_at", "transaction_id", "tx_hash"].sort(),
      );
      expect(await jobsFor(eventId)).toEqual([
        { reservationId: receipt.partnerUserRef, eventId, eventType: "onramp.transaction.success", trace_id: "trace_01" },
      ]);
    });

    it("is a no-op for a redelivered event id, including when the same delivery arrives concurrently", async () => {
      const eventId = `evt_${randomUUID()}`;
      const receipt = receiptFor(eventId);

      const results = await Promise.all([
        repository.receiveOnrampWebhook(receipt, "trace_01"),
        repository.receiveOnrampWebhook(receipt, "trace_02"),
        repository.receiveOnrampWebhook(receipt, "trace_03"),
      ]);
      expect(await repository.receiveOnrampWebhook(receipt, "trace_04")).toBe("duplicate");

      expect(results.slice().sort()).toEqual(["duplicate", "duplicate", "enqueued"]);
      expect(await receiptsFor(eventId)).toHaveLength(1);
      expect(await jobsFor(eventId)).toHaveLength(1);
    });

    it("keeps a distinct event id for the same transaction as its own receipt and job", async () => {
      const first = receiptFor(`evt_${randomUUID()}`, "reservation_shared");
      const second = { ...receiptFor(`evt_${randomUUID()}`, "reservation_shared"), eventType: "onramp.transaction.updated" };

      expect(await repository.receiveOnrampWebhook(first, "trace_01")).toBe("enqueued");
      expect(await repository.receiveOnrampWebhook(second, "trace_02")).toBe("enqueued");
      expect(await jobsFor(second.eventId)).toHaveLength(1);
    });

    it("writes no receipt when the job cannot be enqueued, so a redelivery can still succeed", async () => {
      const eventId = `evt_${randomUUID()}`;
      const receipt = receiptFor(eventId);
      const failing = new PrismaOfferingRepository(
        database,
        { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) } as unknown as PgBoss,
        kycRepository,
      );

      await expect(failing.receiveOnrampWebhook(receipt, "trace_01")).rejects.toThrow("queue unavailable");
      expect(await receiptsFor(eventId)).toHaveLength(0);

      expect(await repository.receiveOnrampWebhook(receipt, "trace_02")).toBe("enqueued");
      expect(await receiptsFor(eventId)).toHaveLength(1);
      expect(await jobsFor(eventId)).toHaveLength(1);
    });

    it("rejects every UPDATE and DELETE of a receipt (append-only), and an id outside the length limits", async () => {
      const eventId = `evt_${randomUUID()}`;
      await repository.receiveOnrampWebhook(receiptFor(eventId), "trace_01");

      await expect(
        authPool.query("UPDATE money.onramp_webhook_receipts SET tx_hash = 'x' WHERE event_id = $1", [eventId]),
      ).rejects.toMatchObject({ code: "23000" });
      await expect(
        authPool.query("DELETE FROM money.onramp_webhook_receipts WHERE event_id = $1", [eventId]),
      ).rejects.toMatchObject({ code: "23000" });
      expect(await receiptsFor(eventId)).toHaveLength(1);

      await expect(repository.receiveOnrampWebhook({ ...receiptFor(`evt_${randomUUID()}`), txHash: "" }, "trace_01")).rejects.toThrow();
      await expect(
        repository.receiveOnrampWebhook({ ...receiptFor("x".repeat(201)) }, "trace_01"),
      ).rejects.toThrow();
    });
  });
});
