import { randomUUID } from "node:crypto";

import pino from "pino";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import type {
  CoinbaseCdpClient,
  OnrampTransactionSummary,
} from "../src/modules/offering/application/coinbase-cdp-client.js";
import { CheckOnrampLateEvidenceService } from "../src/modules/offering/application/check-onramp-late-evidence.service.js";
import { ReconcileOnrampWebhookService } from "../src/modules/offering/application/coinbase-onramp-webhook.service.js";
import { PollOnrampTransactionsService } from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import { RecordOnrampLateEvidenceService } from "../src/modules/offering/application/record-onramp-late-evidence.service.js";
import type { RecordOnrampLateEvidenceInput } from "../src/modules/offering/repository/onramp-late-evidence.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { PrismaOnrampLateEvidenceRepository } from "../src/modules/offering/repository/prisma-onramp-late-evidence.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const farFutureIpoEndAt = new Date("2099-12-31T00:00:00.000Z");
const webhookQueue = "provider_events.coinbase_onramp_webhook";
const wallet = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const silent = pino({ level: "silent" });

// Real PostgreSQL: the evidence row the late path writes when the single onramp
// recording method answers other_stage (AD-288), what the table enforces
// (unique transaction, the stage and state checks, immutability apart from one
// review mark), the mark-reviewed transaction with its audit row, and the
// standing alert's read. The unit tests pin the classification and the route;
// these pin that the database holds under repetition and concurrency.
describe.skipIf(databaseUrl === undefined)("onramp late evidence PostgreSQL integration (AD-288)", () => {
  const suffix = randomUUID();
  const accountId = `account_late_evidence_${suffix}`;
  const staffId = `account_late_staff_${suffix}`;
  const betterAuthUserId = `auth_late_evidence_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  let boss: PgBoss;
  let offerings: PrismaOfferingRepository;
  let evidence: PrismaOnrampLateEvidenceRepository;
  const evidenceIds: string[] = [];

  async function createOffering(): Promise<string> {
    const id = randomUUID();
    const propertyId = `property_late_evidence_${id}`;
    const caseId = `case_late_evidence_${id}`;
    const pivId = `piv_late_evidence_${id}`;
    const offeringId = `offering_late_evidence_${id}`;
    await database.property.create({
      data: { id: propertyId, countryCode: "DE", city: "Leipzig", addressLine: "Late Evidence Test 1", ownerDeclaredValueEur: "600000.00" },
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
    await offerings.createReservation({
      reservationId,
      offeringId: await createOffering(),
      accountId,
      amountEur,
      disclosurePackVersionAtReservation: null,
      traceId: `trace_${suffix}`,
      createdAt: new Date(start),
    });
    await offerings.recordMoneyEvent({
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

  async function lapsed(): Promise<{ reservationId: string; start: number }> {
    const reservation = await newReservation();
    expect(
      await offerings.expireReservation({
        reservationId: reservation.reservationId,
        traceId: `trace_${suffix}`,
        expiredAt: new Date(reservation.start + 2_000),
      }),
    ).toBe(true);
    return reservation;
  }

  const transaction = (overrides: Partial<OnrampTransactionSummary> = {}): OnrampTransactionSummary => ({
    transactionId: `txn_${randomUUID()}`,
    status: "success",
    walletAddress: wallet,
    purchaseCurrency: "EURC",
    purchaseAmountValue: "99.000000",
    paymentTotalCurrency: "EUR",
    paymentTotalValue: "100.00",
    txHash: "0xabc",
    createdAt: new Date("2026-11-17T10:00:00.000Z"),
    completedAt: new Date("2026-11-17T10:05:00.000Z"),
    ...overrides,
  });

  // The worker's composition: the poller over the real recording method, with
  // the late-evidence handler, and the webhook job on top of it.
  function worker(transactions: OnrampTransactionSummary[], observedAt = new Date("2026-11-17T12:00:00.000Z")) {
    const listBuyTransactions = vi.fn().mockResolvedValue({ transactions, nextPageKey: null });
    const coinbase: CoinbaseCdpClient = { createOnrampSessionToken: vi.fn(), buildOnrampUrl: vi.fn(), listBuyTransactions };
    const poller = new PollOnrampTransactionsService(
      offerings,
      coinbase,
      silent,
      () => observedAt,
      new RecordOnrampLateEvidenceService(evidence, silent),
    );
    const job = new ReconcileOnrampWebhookService(offerings, poller);
    const webhook = (reservationId: string, eventId = `evt_${randomUUID()}`) => ({
      reservationId,
      eventId,
      eventType: "onramp.transaction.success",
      trace_id: `trace_job_${suffix}`,
    });
    return { poller, job, webhook, listBuyTransactions };
  }

  async function rowsFor(reservationId: string) {
    return (
      await authPool.query(
        "SELECT * FROM money.onramp_late_evidence WHERE reservation_id = $1 ORDER BY onramp_late_evidence_id",
        [reservationId],
      )
    ).rows;
  }

  async function history(reservationId: string): Promise<Array<[string, string | null]>> {
    const events = await database.moneyEvent.findMany({
      where: { reservationId },
      orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
    });
    return events.map((event) => [event.capitalState, event.providerReference]);
  }

  function input(reservationId: string, overrides: Partial<RecordOnrampLateEvidenceInput> = {}): RecordOnrampLateEvidenceInput {
    return {
      providerTransactionId: `txn_${randomUUID()}`,
      txHash: "0xabc",
      destinationWallet: wallet,
      reservationId,
      reservationStage: "lapsed",
      amount: "99.000000",
      asset: "EURC",
      state: "eurc_reserved",
      observedAt: new Date("2026-11-17T12:00:00.000Z"),
      traceId: `trace_${suffix}`,
      ...overrides,
    };
  }

  async function record(reservationId: string, overrides: Partial<RecordOnrampLateEvidenceInput> = {}) {
    const result = await evidence.recordLateEvidence(input(reservationId, overrides));
    evidenceIds.push(result.evidenceId);
    return result;
  }

  async function auditFor(evidenceId: string) {
    return database.auditLog.findMany({
      where: { resourceType: "onramp_late_evidence", resourceId: evidenceId },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    offerings = new PrismaOfferingRepository(database, boss, new PrismaKycRepository(database, boss));
    evidence = new PrismaOnrampLateEvidenceRepository(database);
    await boss.start();
    await boss.createQueue(webhookQueue);
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Late Evidence Investor", `late-evidence-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    const staffAuthId = `auth_late_staff_${suffix}`;
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [staffAuthId, "Late Evidence Staff", `late-staff-${suffix}@example.test`, true, "staff_partner"],
    );
    await database.account.create({ data: { id: staffId, betterAuthUserId: staffAuthId } });
  });

  afterAll(async () => {
    // The evidence table and money_events are immutable and hold foreign keys
    // into the reservations, so what the tests create stays behind, uniquely
    // suffixed per run like the other offering suites. Only this run's audit
    // rows are removed.
    await database.auditLog.deleteMany({ where: { resourceType: "onramp_late_evidence", resourceId: { in: evidenceIds } } });
    await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
  });

  describe("the webhook job and the poll over the real recording method", () => {
    it("writes one entry for a success on a lapsed reservation, with every field, and not a money event", async () => {
      const { reservationId } = await lapsed();
      const success = transaction({ transactionId: `txn_late_${suffix}`, purchaseAmountValue: "99.000000", txHash: "0xdeadbeef" });
      const { job, webhook } = worker([success], new Date("2026-11-17T12:00:00.000Z"));

      const result = await job.execute(webhook(reservationId));

      expect(result).toMatchObject({ status: "resolved", recording: "other_stage" });
      const [row] = await rowsFor(reservationId);
      evidenceIds.push(row.onramp_late_evidence_id);
      expect(row).toMatchObject({
        provider_transaction_id: `txn_late_${suffix}`,
        tx_hash: "0xdeadbeef",
        destination_wallet: wallet,
        reservation_id: reservationId,
        reservation_stage: "lapsed",
        asset: "EURC",
        state: "eurc_reserved",
        reviewed_at: null,
      });
      expect(row.amount).toBe("99.000000");
      expect(row.observed_at).toEqual(new Date("2026-11-17T12:00:00.000Z"));
      expect(row.onramp_late_evidence_id).toMatch(/^onramp_late_evidence_/);
      // No money: the history is the creation and the pending event only, and the reservation stayed lapsed.
      expect(await history(reservationId)).toEqual([
        ["initiated", null],
        ["eurc_purchase_pending", "channel_01"],
      ]);
      expect(await database.reservation.findUnique({ where: { id: reservationId } })).toMatchObject({ reservationStage: "lapsed" });
      // The entry says so in the audit trail, with ids only.
      const [audit] = await auditFor(row.onramp_late_evidence_id);
      expect(audit).toMatchObject({ actorAccountId: null, action: "offering.onramp_late_evidence_recorded" });
      expect(audit?.changes).toEqual({
        trace_id: `trace_job_${suffix}`,
        reservation_id: reservationId,
        provider_transaction_id: `txn_late_${suffix}`,
        reservation_stage: "lapsed",
        state: "eurc_reserved",
      });
      expect(JSON.stringify(audit?.changes)).not.toContain(wallet);
      expect(JSON.stringify(audit?.changes)).not.toContain("0xdeadbeef");
    });

    it("writes the entry for a cancelled reservation too", async () => {
      const { reservationId } = await newReservation();
      await database.reservation.update({ where: { id: reservationId }, data: { reservationStage: "cancelled" } });
      const { job, webhook } = worker([transaction()]);

      await job.execute(webhook(reservationId));

      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows.map((row) => row.reservation_stage)).toEqual(["cancelled"]);
      expect(await history(reservationId)).toHaveLength(2);
    });

    it("writes the entry for a further success on a reservation that is already funded and moved on, and leaves the funding as it was", async () => {
      const { reservationId, start } = await newReservation();
      const first = transaction({ transactionId: `txn_first_${randomUUID()}` });
      expect(
        await offerings.recordOnrampOutcome({
          reservationId,
          provider: "coinbase_cdp",
          providerReference: first.transactionId,
          capitalState: "eurc_reserved",
          amountEur: "100.00",
          amountEurc: "99.000000",
          recordedAt: new Date(start + 3_000),
        }),
      ).toEqual({ status: "recorded" });
      await database.reservation.update({ where: { id: reservationId }, data: { reservationStage: "awaiting_reconfirmation" } });
      const second = transaction({ transactionId: `txn_second_${randomUUID()}` });

      // The funding transaction delivered again is a duplicate, so it never reads as late.
      const redelivery = worker([first]);
      await redelivery.job.execute(redelivery.webhook(reservationId));
      expect(await rowsFor(reservationId)).toEqual([]);

      // A further success (the list shows the newer one first) is evidence, on top of the funding.
      const { job, webhook } = worker([second, first]);
      await job.execute(webhook(reservationId));

      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows.map((row) => [row.provider_transaction_id, row.reservation_stage, row.state])).toEqual([
        [second.transactionId, "awaiting_reconfirmation", "eurc_reserved"],
      ]);
      expect((await history(reservationId)).filter(([state]) => state === "eurc_reserved")).toEqual([
        ["eurc_reserved", first.transactionId],
      ]);
    });

    it("writes nothing for a failed attempt on a lapsed reservation: no money moved", async () => {
      const { reservationId } = await lapsed();
      const { job, webhook } = worker([transaction({ status: "failed" })]);

      const result = await job.execute({ ...webhook(reservationId), eventType: "onramp.transaction.failed" });

      expect(result).toMatchObject({ status: "resolved", recording: "other_stage" });
      expect(await rowsFor(reservationId)).toEqual([]);
    });

    it("records money, not evidence, for a success on a reservation that is still initiated", async () => {
      const { reservationId } = await newReservation();
      const { job, webhook } = worker([transaction({ transactionId: `txn_on_time_${randomUUID()}` })]);

      const result = await job.execute(webhook(reservationId));

      expect(result).toMatchObject({ status: "resolved", recording: "recorded" });
      expect(await rowsFor(reservationId)).toEqual([]);
      expect((await history(reservationId)).at(-1)?.[0]).toBe("eurc_reserved");
    });

    it("keeps a late success that does not cover the reservation, in its own state: the money still arrived", async () => {
      const { reservationId } = await lapsed();
      const other = transaction({ transactionId: `txn_other_${randomUUID()}`, purchaseCurrency: "ETH", purchaseAmountValue: "0.030000" });
      const { job, webhook } = worker([other]);

      await job.execute(webhook(reservationId));

      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows.map((row) => [row.provider_transaction_id, row.state, row.asset])).toEqual([
        [other.transactionId, "purchase_failed", "ETH"],
      ]);
    });

    it("is idempotent on the provider transaction: a redelivered webhook, another event and the poll's re-check leave one entry and one audit row", async () => {
      const { reservationId } = await lapsed();
      const success = transaction({ transactionId: `txn_repeat_${randomUUID()}` });
      const { job, webhook, poller } = worker([success]);

      await job.execute(webhook(reservationId, "evt_first"));
      await job.execute(webhook(reservationId, "evt_first"));
      await job.execute(webhook(reservationId, "evt_second"));
      await poller.reconcileReservation({ reservationId, amountEur: "100.00" }, "trace_poll");

      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows).toHaveLength(1);
      // The first sighting stands: its trace and its time.
      expect(await auditFor(rows[0].onramp_late_evidence_id)).toHaveLength(1);
    });

    it("hands the poll's own late find, a lapse landing between its list and its lock, to the same path", async () => {
      const { reservationId } = await newReservation();
      const success = transaction({ transactionId: `txn_race_${randomUUID()}` });
      const { poller } = worker([success]);
      // The poll listed this reservation as initiated, then the expiry sweep lapsed it.
      await offerings.expireReservation({ reservationId, traceId: `trace_${suffix}`, expiredAt: new Date(Date.now() + 1_000) });

      const result = await poller.reconcileReservation({ reservationId, amountEur: "100.00" }, "trace_poll");

      expect(result).toMatchObject({ status: "resolved", recording: { status: "other_stage", reservationStage: "lapsed" } });
      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows).toHaveLength(1);
    });

    it("is not watched by the minute poll any more: a lapsed reservation costs no Coinbase call", async () => {
      const { reservationId } = await lapsed();
      const { poller, listBuyTransactions } = worker([transaction()]);

      await poller.execute("trace_poll");

      const asked = listBuyTransactions.mock.calls.map(([call]) => (call as { partnerUserRef: string }).partnerUserRef);
      expect(asked).not.toContain(reservationId);
      expect(await rowsFor(reservationId)).toEqual([]);
    });
  });

  // The list is the point of the feature, so which successes reach it must not
  // depend on the order Coinbase returns its transactions in (not verified, and
  // a webhook job cannot control it). Once a reservation has left 'initiated'
  // every success of its list is offered to the recording method, and the
  // duplicate-first policy keeps the funding transaction itself off the list.
  describe("every success of the list reaches the evidence list, in whatever order Coinbase returns it", () => {
    const orders: Array<[string, (older: OnrampTransactionSummary, newer: OnrampTransactionSummary) => OnrampTransactionSummary[]]> = [
      ["newest first", (older, newer) => [newer, older]],
      ["oldest first", (older, newer) => [older, newer]],
    ];

    // Funded by `funding` while initiated (as the poll or a webhook job would
    // have recorded it), then moved on to a stage only a funded reservation reaches.
    async function fundedAndMovedOn(funding: OnrampTransactionSummary): Promise<string> {
      const { reservationId, start } = await newReservation();
      expect(
        await offerings.recordOnrampOutcome({
          reservationId,
          provider: "coinbase_cdp",
          providerReference: funding.transactionId,
          capitalState: "eurc_reserved",
          amountEur: "100.00",
          amountEurc: "99.000000",
          recordedAt: new Date(start + 3_000),
        }),
      ).toEqual({ status: "recorded" });
      await database.reservation.update({ where: { id: reservationId }, data: { reservationStage: "awaiting_reconfirmation" } });
      return reservationId;
    }

    it.each(orders)("lists a further success on a funded reservation that moved on, and never its funding transaction, %s", async (_order, arrange) => {
      const funding = transaction({ transactionId: `txn_funding_${randomUUID()}` });
      const further = transaction({ transactionId: `txn_further_${randomUUID()}` });
      const reservationId = await fundedAndMovedOn(funding);
      const { job, webhook } = worker(arrange(funding, further));

      await job.execute(webhook(reservationId));

      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows.map((row) => [row.provider_transaction_id, row.reservation_stage])).toEqual([
        [further.transactionId, "awaiting_reconfirmation"],
      ]);
      expect((await history(reservationId)).filter(([state]) => state === "eurc_reserved")).toEqual([
        ["eurc_reserved", funding.transactionId],
      ]);
    });

    it.each(orders)("lists a second late success beside one already listed, %s", async (_order, arrange) => {
      const { reservationId } = await lapsed();
      const earlier = transaction({ transactionId: `txn_earlier_${randomUUID()}` });
      const later = transaction({ transactionId: `txn_later_${randomUUID()}` });
      const firstSighting = worker([earlier]);
      await firstSighting.job.execute(firstSighting.webhook(reservationId));

      const { job, webhook } = worker(arrange(earlier, later));
      await job.execute(webhook(reservationId));
      await job.execute(webhook(reservationId));

      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows.map((row) => row.provider_transaction_id).sort()).toEqual([earlier.transactionId, later.transactionId].sort());
      // Seeing the earlier one again changed nothing: one audit row each.
      for (const row of rows) expect(await auditFor(row.onramp_late_evidence_id)).toHaveLength(1);
    });

    it.each(orders)("lists both of two late successes seen together, and not the failed attempt beside them, %s", async (_order, arrange) => {
      const { reservationId } = await lapsed();
      const covering = transaction({ transactionId: `txn_covering_${randomUUID()}` });
      const small = transaction({ transactionId: `txn_small_${randomUUID()}`, purchaseAmountValue: "10.000000" });
      const failed = transaction({ transactionId: `txn_failed_${randomUUID()}`, status: "failed" });
      const { job, webhook } = worker([...arrange(covering, small), failed]);

      await job.execute(webhook(reservationId));

      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows.map((row) => [row.provider_transaction_id, row.state]).sort()).toEqual(
        [
          [covering.transactionId, "eurc_reserved"],
          [small.transactionId, "purchase_failed"],
        ].sort(),
      );
    });

    it.each(orders)("reads a duplicate on a reservation that moved on as late too: a purchase_failed already on file, then another success, %s", async (_order, arrange) => {
      const { reservationId, start } = await newReservation();
      const earlier = transaction({ transactionId: `txn_wrong_asset_${randomUUID()}`, purchaseCurrency: "ETH", purchaseAmountValue: "0.030000" });
      const later = transaction({ transactionId: `txn_wrong_asset_later_${randomUUID()}`, purchaseCurrency: "ETH", purchaseAmountValue: "0.040000" });
      // While initiated, the poll records the uncovered success as purchase_failed money.
      const onTime = worker([earlier]);
      expect(await onTime.poller.reconcileReservation({ reservationId, amountEur: "100.00" }, "trace_poll")).toMatchObject({
        recording: { status: "recorded" },
      });
      expect(await offerings.expireReservation({ reservationId, traceId: `trace_${suffix}`, expiredAt: new Date(start + 10_000) })).toBe(true);

      const { job, webhook } = worker(arrange(earlier, later));
      await job.execute(webhook(reservationId));

      // The first is money already on file (a duplicate), the second is late evidence.
      const rows = await rowsFor(reservationId);
      evidenceIds.push(...rows.map((row) => row.onramp_late_evidence_id));
      expect(rows.map((row) => [row.provider_transaction_id, row.state])).toEqual([[later.transactionId, "purchase_failed"]]);
      expect((await history(reservationId)).filter(([state]) => state === "purchase_failed")).toEqual([
        ["purchase_failed", earlier.transactionId],
      ]);
    });

    // The edge of the list, pinned so that a change to it is deliberate. A
    // further success on a reservation that is funded but still 'initiated' (a
    // double payment before the reconfirmation window opens) is not late: the
    // recording method answers already_funded, which the late path does not
    // consume (AD-289: it consumes other_stage). Whether AD-288's "unmatched"
    // covers it is open; see docs/investor-offering.md, "What it does not cover".
    it("lists nothing for a further success on a funded reservation that is still initiated, and writes no money for it", async () => {
      const { reservationId } = await newReservation();
      const funding = transaction({ transactionId: `txn_funding_${randomUUID()}` });
      const further = transaction({ transactionId: `txn_double_${randomUUID()}` });
      const first = worker([funding]);
      expect(await first.job.execute(first.webhook(reservationId))).toMatchObject({ recording: "recorded" });

      const { job, webhook } = worker([further, funding]);
      const result = await job.execute(webhook(reservationId));

      expect(result).toMatchObject({ status: "resolved", recording: "already_funded" });
      expect(await rowsFor(reservationId)).toEqual([]);
      expect((await history(reservationId)).filter(([state]) => state === "eurc_reserved")).toEqual([
        ["eurc_reserved", funding.transactionId],
      ]);
    });

    it("offers no further success to the recording method while the reservation is still initiated: no extra purchase_failed row, however many times it is polled", async () => {
      const { reservationId } = await newReservation();
      const one = transaction({ transactionId: `txn_one_${randomUUID()}`, purchaseCurrency: "ETH", purchaseAmountValue: "0.030000" });
      const two = transaction({ transactionId: `txn_two_${randomUUID()}`, purchaseCurrency: "ETH", purchaseAmountValue: "0.040000" });
      const { poller } = worker([one, two]);

      for (let run = 0; run < 3; run += 1) {
        await poller.reconcileReservation({ reservationId, amountEur: "100.00" }, "trace_poll");
      }

      // The method records the one transaction it resolves the list to, as before, and no more.
      expect((await history(reservationId)).filter(([state]) => state === "purchase_failed")).toEqual([
        ["purchase_failed", one.transactionId],
      ]);
      expect(await rowsFor(reservationId)).toEqual([]);
    });
  });

  describe("recordLateEvidence", () => {
    it("is idempotent under concurrent writers: one row, one audit row, one winner", async () => {
      const { reservationId } = await lapsed();
      const same = input(reservationId, { providerTransactionId: `txn_concurrent_${randomUUID()}` });

      const results = await Promise.all(Array.from({ length: 6 }, () => evidence.recordLateEvidence(same)));

      expect(results.filter((result) => result.newlyRecorded)).toHaveLength(1);
      expect(new Set(results.map((result) => result.evidenceId)).size).toBe(1);
      const id = results[0]!.evidenceId;
      evidenceIds.push(id);
      expect(await rowsFor(reservationId)).toHaveLength(1);
      expect(await auditFor(id)).toHaveLength(1);
    });

    it("keeps the first sighting when the same transaction is seen again with other details", async () => {
      const { reservationId } = await lapsed();
      const transactionId = `txn_first_wins_${randomUUID()}`;
      const first = await record(reservationId, { providerTransactionId: transactionId, observedAt: new Date("2026-11-17T09:00:00.000Z") });
      const second = await evidence.recordLateEvidence(
        input(reservationId, { providerTransactionId: transactionId, observedAt: new Date("2026-11-17T15:00:00.000Z"), amount: "1.000000" }),
      );

      expect(first.newlyRecorded).toBe(true);
      expect(second).toEqual({ evidenceId: first.evidenceId, newlyRecorded: false });
      const [row] = await rowsFor(reservationId);
      expect(row.observed_at).toEqual(new Date("2026-11-17T09:00:00.000Z"));
      expect(row.amount).toBe("99.000000");
    });

    it("refuses a reservation that does not exist: a foreign key, not a conflict that is skipped", async () => {
      await expect(evidence.recordLateEvidence(input(`reservation_${randomUUID()}`))).rejects.toThrow();
    });
  });

  describe("what the table enforces", () => {
    async function sqlState(run: () => Promise<unknown>): Promise<string | undefined> {
      try {
        await run();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    }

    function insertSql(overrides: Partial<Record<string, unknown>> = {}) {
      const values = {
        id: `onramp_late_evidence_sql_${randomUUID()}`,
        provider_transaction_id: `txn_sql_${randomUUID()}`,
        tx_hash: "0xabc",
        destination_wallet: wallet,
        reservation_id: "",
        reservation_stage: "lapsed",
        amount: "99.000000",
        asset: "EURC",
        state: "eurc_reserved",
        observed_at: new Date("2026-11-17T12:00:00.000Z"),
        ...overrides,
      };
      return authPool.query(
        `INSERT INTO money.onramp_late_evidence (onramp_late_evidence_id, provider_transaction_id, tx_hash, destination_wallet, reservation_id, reservation_stage, amount, asset, state, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)`,
        [values.id, values.provider_transaction_id, values.tx_hash, values.destination_wallet, values.reservation_id, values.reservation_stage, values.amount, values.asset, values.state, values.observed_at],
      );
    }

    it.each([
      ["a stage of initiated (an initiated reservation takes the money event)", { reservation_stage: "initiated" }],
      ["a state other than the two the recording method writes", { state: "refund_pending" }],
      ["a negative amount", { amount: "-1.000000" }],
      ["a NaN amount", { amount: "NaN" }],
      ["an empty provider transaction id", { provider_transaction_id: "" }],
      ["an oversized provider transaction id", { provider_transaction_id: "t".repeat(201) }],
      ["an empty asset", { asset: "" }],
    ])("rejects %s", async (_label, overrides) => {
      const { reservationId } = await lapsed();
      expect(await sqlState(() => insertSql({ reservation_id: reservationId, ...overrides }))).toBe("23514");
    });

    it("rejects a second row for the same provider transaction id", async () => {
      const { reservationId } = await lapsed();
      const transactionId = `txn_unique_${randomUUID()}`;
      const first = await record(reservationId, { providerTransactionId: transactionId });
      expect(first.newlyRecorded).toBe(true);

      expect(await sqlState(() => insertSql({ reservation_id: reservationId, provider_transaction_id: transactionId }))).toBe("23505");
    });

    it("rejects an entry for a reservation that does not exist", async () => {
      expect(await sqlState(() => insertSql({ reservation_id: `reservation_${randomUUID()}` }))).toBe("23503");
    });

    it("never changes or deletes an entry, except to set reviewed_at once", async () => {
      const { reservationId } = await lapsed();
      const { evidenceId } = await record(reservationId);
      const where = [evidenceId];

      for (const statement of [
        "UPDATE money.onramp_late_evidence SET amount = 1 WHERE onramp_late_evidence_id = $1",
        "UPDATE money.onramp_late_evidence SET state = 'purchase_failed' WHERE onramp_late_evidence_id = $1",
        "UPDATE money.onramp_late_evidence SET destination_wallet = '0x0' WHERE onramp_late_evidence_id = $1",
        "UPDATE money.onramp_late_evidence SET observed_at = now() WHERE onramp_late_evidence_id = $1",
        "UPDATE money.onramp_late_evidence SET reviewed_at = NULL WHERE onramp_late_evidence_id = $1",
        "UPDATE money.onramp_late_evidence SET reviewed_at = now(), amount = 1 WHERE onramp_late_evidence_id = $1",
        "DELETE FROM money.onramp_late_evidence WHERE onramp_late_evidence_id = $1",
      ]) {
        expect(await sqlState(() => authPool.query(statement, where)), statement).toBe("23000");
      }

      await authPool.query("UPDATE money.onramp_late_evidence SET reviewed_at = now() WHERE onramp_late_evidence_id = $1", where);
      for (const statement of [
        "UPDATE money.onramp_late_evidence SET reviewed_at = now() + interval '1 hour' WHERE onramp_late_evidence_id = $1",
        "UPDATE money.onramp_late_evidence SET reviewed_at = NULL WHERE onramp_late_evidence_id = $1",
        "DELETE FROM money.onramp_late_evidence WHERE onramp_late_evidence_id = $1",
      ]) {
        expect(await sqlState(() => authPool.query(statement, where)), statement).toBe("23000");
      }
      const [row] = await rowsFor(reservationId);
      expect(row.reviewed_at).not.toBeNull();
      expect(row.amount).toBe("99.000000");
    });
  });

  describe("markLateEvidenceReviewed and the list", () => {
    it("marks an entry reviewed once, with an audit row naming the staff account, and a second mark changes nothing", async () => {
      const { reservationId } = await lapsed();
      const { evidenceId } = await record(reservationId);
      const reviewedAt = new Date("2026-11-17T13:00:00.000Z");

      const first = await evidence.markLateEvidenceReviewed({ evidenceId, actorAccountId: staffId, traceId: "trace_review_1", reviewedAt });
      const second = await evidence.markLateEvidenceReviewed({
        evidenceId,
        actorAccountId: staffId,
        traceId: "trace_review_2",
        reviewedAt: new Date("2026-11-17T14:00:00.000Z"),
      });

      expect(first).toMatchObject({ status: "reviewed", entry: { evidenceId, reviewedAt, reservationStage: "lapsed" } });
      expect(second).toMatchObject({ status: "already_reviewed", entry: { evidenceId, reviewedAt } });
      const audit = (await auditFor(evidenceId)).filter((row) => row.action === "offering.onramp_late_evidence_reviewed");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorAccountId: staffId, resourceType: "onramp_late_evidence", resourceId: evidenceId });
      expect(audit[0]?.changes).toMatchObject({ trace_id: "trace_review_1", reservation_id: reservationId, reviewed_at: reviewedAt.toISOString() });
      // Marking an entry reviewed changes the entry only: not the reservation, not its money.
      expect(await database.reservation.findUnique({ where: { id: reservationId } })).toMatchObject({ reservationStage: "lapsed" });
      expect(await history(reservationId)).toHaveLength(2);
    });

    it("answers not_found for an entry that does not exist, and writes no audit row", async () => {
      const missing = `onramp_late_evidence_missing_${randomUUID()}`;
      expect(
        await evidence.markLateEvidenceReviewed({ evidenceId: missing, actorAccountId: staffId, traceId: "trace_review", reviewedAt: new Date() }),
      ).toEqual({ status: "not_found" });
      expect(await auditFor(missing)).toEqual([]);
    });

    it("leaves one review time and one audit row when two staff mark the same entry at once", async () => {
      const { reservationId } = await lapsed();
      const { evidenceId } = await record(reservationId);

      const results = await Promise.all(
        [1, 2, 3, 4].map((n) =>
          evidence.markLateEvidenceReviewed({
            evidenceId,
            actorAccountId: staffId,
            traceId: `trace_review_${n}`,
            reviewedAt: new Date(`2026-11-17T13:0${n}:00.000Z`),
          }),
        ),
      );

      expect(results.map((result) => result.status).sort()).toEqual(["already_reviewed", "already_reviewed", "already_reviewed", "reviewed"]);
      const reviewedTimes = new Set(results.map((result) => (result.status === "not_found" ? null : result.entry.reviewedAt?.toISOString())));
      expect(reviewedTimes.size).toBe(1);
      expect((await auditFor(evidenceId)).filter((row) => row.action === "offering.onramp_late_evidence_reviewed")).toHaveLength(1);
    });

    it("lists newest first with an exclusive cursor, the review state filter, and the reservation's stage now", async () => {
      const { reservationId } = await lapsed();
      const a = await record(reservationId);
      const b = await record(reservationId);
      const c = await record(reservationId);
      await evidence.markLateEvidenceReviewed({ evidenceId: b.evidenceId, actorAccountId: staffId, traceId: "trace_review", reviewedAt: new Date() });
      // The stage has moved on since the transaction was seen.
      await database.reservation.update({ where: { id: reservationId }, data: { reservationStage: "cancelled" } });

      const mine = async (reviewState?: "unreviewed" | "reviewed") =>
        (await evidence.listLateEvidence({ limit: 100, ...(reviewState === undefined ? {} : { reviewState }) }))
          .filter((row) => row.reservationId === reservationId)
          .map((row) => row.evidenceId);

      expect(await mine()).toEqual([c.evidenceId, b.evidenceId, a.evidenceId]);
      expect(await mine("unreviewed")).toEqual([c.evidenceId, a.evidenceId]);
      expect(await mine("reviewed")).toEqual([b.evidenceId]);

      const page = await evidence.listLateEvidence({ limit: 1, after: c.evidenceId });
      expect(page).toHaveLength(2);
      expect(page[0]).toMatchObject({ evidenceId: b.evidenceId, reservationStage: "lapsed", currentReservationStage: "cancelled" });
    });
  });

  describe("the standing alert", () => {
    it("is raised while an entry is unreviewed, on every run, and stops once the last one is marked reviewed", async () => {
      // Entries left by earlier tests and runs are reviewed first (the one
      // update the table allows), so what is counted here is this test's. Only
      // this file writes to the table, and its tests run one after another.
      await authPool.query("UPDATE money.onramp_late_evidence SET reviewed_at = now() WHERE reviewed_at IS NULL");
      const lines: Array<Record<string, unknown>> = [];
      const capturing = pino({ level: "warn" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
      const check = new CheckOnrampLateEvidenceService(evidence, capturing, () => new Date("2026-11-17T16:00:00.000Z"));
      expect(await check.execute("trace_alert_0")).toEqual({ checked: 0, acted: 0, unreviewed: 0 });
      expect(lines).toEqual([]);

      const { reservationId } = await lapsed();
      const older = await record(reservationId, { observedAt: new Date("2026-11-17T12:00:00.000Z") });
      const newer = await record(reservationId, { observedAt: new Date("2026-11-17T14:00:00.000Z") });

      expect(await check.execute("trace_alert_1")).toEqual({ checked: 2, acted: 1, unreviewed: 2 });
      expect(await check.execute("trace_alert_2")).toEqual({ checked: 2, acted: 1, unreviewed: 2 });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        level: 40,
        event: "offering.onramp_late_evidence_unreviewed",
        severity: "warn",
        job: "maintenance.onramp_late_evidence_alert",
        trace_id: "trace_alert_1",
        unreviewed_count: 2,
        oldest_unreviewed_age_seconds: 4 * 3600,
        evidence_ids: [older.evidenceId, newer.evidenceId],
      });
      // Counts and ids only: neither the wallet nor an amount is in what the alert says.
      expect(JSON.stringify(lines)).not.toContain(wallet);
      expect(JSON.stringify(lines)).not.toContain("99.000000");

      await evidence.markLateEvidenceReviewed({ evidenceId: older.evidenceId, actorAccountId: staffId, traceId: "trace_review", reviewedAt: new Date() });
      expect(await check.execute("trace_alert_3")).toEqual({ checked: 1, acted: 1, unreviewed: 1 });
      expect(lines[2]).toMatchObject({ unreviewed_count: 1, evidence_ids: [newer.evidenceId], oldest_unreviewed_age_seconds: 2 * 3600 });

      await evidence.markLateEvidenceReviewed({ evidenceId: newer.evidenceId, actorAccountId: staffId, traceId: "trace_review", reviewedAt: new Date() });
      expect(await check.execute("trace_alert_4")).toEqual({ checked: 0, acted: 0, unreviewed: 0 });
      expect(lines).toHaveLength(3);
    });

    it("lists the oldest unreviewed entries first and no more than the cap, and still counts them all", async () => {
      await authPool.query("UPDATE money.onramp_late_evidence SET reviewed_at = now() WHERE reviewed_at IS NULL");
      const { reservationId } = await lapsed();
      const ids: string[] = [];
      for (let index = 0; index < 23; index += 1) {
        ids.push((await record(reservationId, { observedAt: new Date(Date.UTC(2026, 10, 17, 0, index)) })).evidenceId);
      }

      const snapshot = await evidence.unreviewedLateEvidenceSnapshot();

      expect(snapshot.unreviewedCount).toBe(23);
      expect(snapshot.oldestObservedAt).toEqual(new Date("2026-11-17T00:00:00.000Z"));
      expect(snapshot.oldestEvidenceIds).toEqual(ids.slice(0, 20));
    });
  });
});
