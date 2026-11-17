import { createHash, createHmac } from "node:crypto";

import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  OnrampOutcomeNotVisibleError,
  ReceiveCoinbaseOnrampWebhookService,
  ReconcileOnrampWebhookService,
} from "../src/modules/offering/application/coinbase-onramp-webhook.service.js";
import type {
  OnrampReconcileResult,
  PollOnrampTransactionsService,
} from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import { CoinbaseOnrampWebhookVerifier } from "../src/modules/offering/infrastructure/coinbase-onramp-webhook-verifier.js";
import type {
  OnrampWebhookReceiver,
  ReservationForOnrampReconciliation,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

const secret = "whsec_test_secret_0123456789";
const now = new Date("2026-05-01T12:00:00.000Z");
const silent = pino({ level: "silent" });

function sign(body: string, timestamp = Math.floor(now.getTime() / 1000)): string {
  const v0 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v0=${v0}`;
}

function appWith(options: { webhook: boolean; receive?: OnrampWebhookReceiver["receiveOnrampWebhook"] }) {
  const receiveOnrampWebhook = vi.fn(options.receive ?? (async () => "enqueued" as const));
  const receiver: OnrampWebhookReceiver = { receiveOnrampWebhook };
  const app = createApp({
    databaseProbe: { check: vi.fn() },
    offeringRepository: {
      listPublic: vi.fn().mockResolvedValue([]),
      getInvestorDetail: vi.fn().mockResolvedValue(null),
    },
    logger: silent,
    corsOrigins: [],
    ...(options.webhook
      ? {
          coinbaseOnrampWebhook: {
            verifier: new CoinbaseOnrampWebhookVerifier(secret, () => now),
            receiveWebhook: new ReceiveCoinbaseOnrampWebhookService(receiver, silent),
          },
        }
      : {}),
  });
  return { app, receiveOnrampWebhook };
}

// The payload keys are ASSUMED (see ParsedCoinbaseOnrampEvent): no real signed
// delivery has been captured yet, so these tests pin the shape the code reads,
// not Coinbase's documented shape.
const event = JSON.stringify({
  eventType: "onramp.transaction.success",
  transactionId: "tx_01",
  txHash: "0xabc",
  partnerUserRef: "reservation_01",
  status: "ONRAMP_TRANSACTION_STATUS_SUCCESS",
  walletAddress: "0x0000000000000000000000000000000000000001",
  country: "DE",
});

function post(app: ReturnType<typeof appWith>["app"], body: string, signature?: string, eventId: string | null = "evt_01") {
  let call = request(app).post("/webhooks/coinbase-onramp").set("content-type", "application/json");
  if (eventId !== null) call = call.set("x-event-id", eventId);
  return (signature === undefined ? call : call.set("x-webhook-signature", signature)).send(body);
}

describe("POST /webhooks/coinbase-onramp", () => {
  it("is not mounted when the webhook secret is not configured", async () => {
    const { app } = appWith({ webhook: false });
    const response = await post(app, event, sign(event));
    expect(response.status).toBe(404);
  });

  it("verifies the signature over the raw body and receives a receipt of ids only", async () => {
    const { app, receiveOnrampWebhook } = appWith({ webhook: true });
    const response = await post(app, event, sign(event));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(receiveOnrampWebhook).toHaveBeenCalledTimes(1);
    expect(receiveOnrampWebhook).toHaveBeenCalledWith(
      {
        eventId: "evt_01",
        eventType: "onramp.transaction.success",
        transactionId: "tx_01",
        txHash: "0xabc",
        partnerUserRef: "reservation_01",
      },
      expect.any(String),
    );
    // Not the status, the wallet address or the country: ids and the event type only.
    expect(JSON.stringify(receiveOnrampWebhook.mock.calls)).not.toMatch(/0x000|"DE"|STATUS_SUCCESS/);
  });

  it("accepts the deprecated X-Hook0-Signature header", async () => {
    const { app, receiveOnrampWebhook } = appWith({ webhook: true });
    const response = await request(app)
      .post("/webhooks/coinbase-onramp")
      .set("content-type", "application/json")
      .set("x-hook0-signature", sign(event))
      .send(event);
    expect(response.status).toBe(200);
    expect(receiveOnrampWebhook).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["wrong", sign(`${event} `)],
    ["stale", sign(event, Math.floor(now.getTime() / 1000) - 301)],
  ])("rejects a %s signature with 401 and the error envelope, and receives nothing", async (_label, signature) => {
    const { app, receiveOnrampWebhook } = appWith({ webhook: true });
    const response = await post(app, event, signature);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "offering.coinbase_webhook_invalid", status: 401 });
    expect(response.body.trace_id).toEqual(expect.any(String));
    expect(receiveOnrampWebhook).not.toHaveBeenCalled();
  });

  it("acknowledges a duplicate delivery with 200 and no further effect", async () => {
    const results = ["enqueued", "duplicate"] as const;
    let call = 0;
    const { app, receiveOnrampWebhook } = appWith({
      webhook: true,
      receive: async () => results[call++] ?? "duplicate",
    });
    const first = await post(app, event, sign(event));
    const second = await post(app, event, sign(event));
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body).toEqual({ received: true });
    expect(receiveOnrampWebhook).toHaveBeenCalledTimes(2);
    expect(receiveOnrampWebhook.mock.calls[0]?.[0].eventId).toBe(receiveOnrampWebhook.mock.calls[1]?.[0].eventId);
  });

  it.each([
    ["an offramp event", { eventType: "offramp.transaction.success", partnerUserRef: "reservation_01" }],
    ["an event without partnerUserRef", { eventType: "onramp.transaction.success" }],
    ["a foreign partnerUserRef", { eventType: "onramp.transaction.success", partnerUserRef: "user_123" }],
    ["a partnerUserRef that is not a string", { eventType: "onramp.transaction.success", partnerUserRef: 42 }],
    ["an event without eventType", { partnerUserRef: "reservation_01" }],
    ["a JSON array", ["onramp.transaction.success"]],
    ["a JSON string", "onramp.transaction.success"],
  ])("acknowledges a verified but unrecognised event (%s) with 200 and receives nothing", async (_label, payload) => {
    const { app, receiveOnrampWebhook } = appWith({ webhook: true });
    const body = JSON.stringify(payload);
    const response = await post(app, body, sign(body));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(receiveOnrampWebhook).not.toHaveBeenCalled();
  });

  it("acknowledges a verified body that is not JSON with 200 and receives nothing", async () => {
    const { app, receiveOnrampWebhook } = appWith({ webhook: true });
    const body = "not json";
    const response = await post(app, body, sign(body));
    expect(response.status).toBe(200);
    expect(receiveOnrampWebhook).not.toHaveBeenCalled();
  });

  it("falls back to a digest of the signed body as the event id when the header is missing, the same for the same bytes", async () => {
    const { app, receiveOnrampWebhook } = appWith({ webhook: true });
    await post(app, event, sign(event), null);
    await post(app, event, sign(event), null);
    const expected = `body-sha256:${createHash("sha256").update(event).digest("hex")}`;
    expect(receiveOnrampWebhook.mock.calls.map(([receipt]) => receipt.eventId)).toEqual([expected, expected]);
  });

  it("stores an id field of an unexpected type or length as null instead of failing the delivery", async () => {
    const { app, receiveOnrampWebhook } = appWith({ webhook: true });
    const body = JSON.stringify({
      eventType: "onramp.transaction.updated",
      partnerUserRef: "reservation_01",
      transactionId: 12345,
      txHash: "",
    });
    const response = await post(app, body, sign(body));
    expect(response.status).toBe(200);
    expect(receiveOnrampWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: null, txHash: null, partnerUserRef: "reservation_01" }),
      expect.any(String),
    );
  });

  it("answers 500 when the receipt cannot be written, so Coinbase redelivers", async () => {
    const { app } = appWith({
      webhook: true,
      receive: async () => {
        throw new Error("database unavailable");
      },
    });
    const response = await post(app, event, sign(event));
    expect(response.status).toBe(500);
  });
});

describe("ReconcileOnrampWebhookService", () => {
  const reservation: ReservationForOnrampReconciliation = {
    reservationId: "reservation_01",
    accountId: "account_01",
    amountEur: "100.00",
    reservationStage: "initiated",
  };
  const job = {
    reservationId: "reservation_01",
    eventId: "evt_01",
    eventType: "onramp.transaction.success",
    trace_id: "req_01",
  };
  const resolved = (status: string): OnrampReconcileResult =>
    ({
      status: "resolved",
      capitalState: "eurc_reserved",
      providerTransactionId: "tx_01",
      recording: { status },
    }) as OnrampReconcileResult;

  function service(found: ReservationForOnrampReconciliation | null, result: OnrampReconcileResult) {
    const findReservationForOnrampReconciliation = vi.fn().mockResolvedValue(found);
    const reservations = { findReservationForOnrampReconciliation } as Pick<
      ReservationRepository,
      "findReservationForOnrampReconciliation"
    >;
    const reconcileReservation = vi.fn().mockResolvedValue(result);
    const poller = { reconcileReservation } as unknown as Pick<PollOnrampTransactionsService, "reconcileReservation">;
    return { reconcile: new ReconcileOnrampWebhookService(reservations, poller), reconcileReservation, findReservationForOnrampReconciliation };
  }

  it("re-fetches through the poller's own reconcileReservation for the one reservation", async () => {
    const { reconcile, reconcileReservation } = service(reservation, resolved("recorded"));
    await expect(reconcile.execute(job)).resolves.toEqual({
      status: "resolved",
      reservation_id: "reservation_01",
      event_id: "evt_01",
      capital_state: "eurc_reserved",
      recording: "recorded",
    });
    expect(reconcileReservation).toHaveBeenCalledWith(reservation, "req_01");
  });

  it.each(["duplicate", "already_funded", "not_awaiting_purchase"])(
    "reports a %s recording without writing anything itself",
    async (status) => {
      const { reconcile } = service(reservation, resolved(status));
      await expect(reconcile.execute(job)).resolves.toMatchObject({ status: "resolved", recording: status });
    },
  );

  it("looks a lapsed reservation up and hands it to the recording method, which answers other_stage", async () => {
    const lapsed = { ...reservation, reservationStage: "lapsed" };
    const { reconcile, reconcileReservation } = service(lapsed, resolved("other_stage"));
    await expect(reconcile.execute(job)).resolves.toMatchObject({ status: "resolved", recording: "other_stage" });
    expect(reconcileReservation).toHaveBeenCalledWith(lapsed, "req_01");
  });

  it("ignores a reservation this database does not know", async () => {
    const { reconcile, reconcileReservation } = service(null, { status: "unresolved" });
    await expect(reconcile.execute(job)).resolves.toEqual({
      status: "ignored",
      reason: "unknown_reservation",
      reservation_id: "reservation_01",
      event_id: "evt_01",
    });
    expect(reconcileReservation).not.toHaveBeenCalled();
  });

  it("completes when Coinbase shows nothing concluded for a reservation the poll still covers", async () => {
    const { reconcile } = service(reservation, { status: "unresolved" });
    await expect(reconcile.execute(job)).resolves.toEqual({
      status: "unresolved",
      reservation_id: "reservation_01",
      event_id: "evt_01",
    });
  });

  it.each(["onramp.transaction.success", "onramp.transaction.failed"])(
    "retries (throws) on %s for a lapsed reservation whose outcome Coinbase does not show yet, since the poll cannot cover it",
    async (eventType) => {
      const { reconcile } = service({ ...reservation, reservationStage: "lapsed" }, { status: "unresolved" });
      await expect(reconcile.execute({ ...job, eventType })).rejects.toBeInstanceOf(OnrampOutcomeNotVisibleError);
    },
  );

  it.each(["onramp.transaction.created", "onramp.transaction.updated"])(
    "does not retry a %s event for a lapsed reservation: nothing terminal was announced",
    async (eventType) => {
      const { reconcile } = service({ ...reservation, reservationStage: "cancelled" }, { status: "unresolved" });
      await expect(reconcile.execute({ ...job, eventType })).resolves.toMatchObject({ status: "unresolved" });
    },
  );

  it("takes the trace id from the job's trace_id and tolerates a job that has none", async () => {
    const { reconcile, reconcileReservation } = service(reservation, resolved("duplicate"));
    const { trace_id: _omitted, ...withoutTrace } = job;
    await reconcile.execute(withoutTrace);
    expect(reconcileReservation).toHaveBeenCalledWith(reservation, "unknown");
  });

  it("rejects a malformed job payload", async () => {
    const { reconcile } = service(reservation, resolved("recorded"));
    await expect(reconcile.execute({ reservationId: 1 })).rejects.toThrow();
    await expect(reconcile.execute({ ...job, reservationId: "user_123" })).rejects.toThrow();
  });
});

describe("ReceiveCoinbaseOnrampWebhookService", () => {
  it("warns about an unreadable payload or an onramp event with no reservation, and only informs about the rest, never logging a body", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const capturing = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    const receive = vi.fn().mockResolvedValue("duplicate");
    const receiver = new ReceiveCoinbaseOnrampWebhookService({ receiveOnrampWebhook: receive }, capturing);

    const event = { eventType: "onramp.transaction.updated", transactionId: null, txHash: null };
    await receiver.execute({ eventId: "evt_a", event: null, traceId: "trace_01" });
    await receiver.execute({ eventId: "evt_b", event: { ...event, partnerUserRef: "reservation_01" }, traceId: "trace_01" });
    await receiver.execute({ eventId: "evt_c", event: { ...event, partnerUserRef: null }, traceId: "trace_01" });
    await receiver.execute({
      eventId: "evt_d",
      event: { ...event, eventType: "offramp.transaction.success", partnerUserRef: "reservation_01" },
      traceId: "trace_01",
    });

    expect(lines.map((line) => [line.level, line.reason ?? "duplicate", line.event_id])).toEqual([
      [40, "unrecognised_payload", "evt_a"],
      [30, "duplicate", "evt_b"],
      [40, "no_reservation_reference", "evt_c"],
      [30, "not_an_onramp_transaction_event", "evt_d"],
    ]);
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
