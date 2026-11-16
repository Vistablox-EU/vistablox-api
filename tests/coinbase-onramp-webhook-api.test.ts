import { createHmac } from "node:crypto";

import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  ReceiveCoinbaseOnrampWebhookService,
  ReconcileOnrampWebhookService,
} from "../src/modules/offering/application/coinbase-onramp-webhook.service.js";
import type { PollOnrampTransactionsService } from "../src/modules/offering/application/poll-onramp-transactions.service.js";
import { CoinbaseOnrampWebhookVerifier } from "../src/modules/offering/infrastructure/coinbase-onramp-webhook-verifier.js";
import type {
  OnrampWebhookJobQueue,
  PendingPurchaseReservationForTimer,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

const secret = "whsec_test_secret_0123456789";
const now = new Date("2026-05-01T12:00:00.000Z");

function sign(body: string, timestamp = Math.floor(now.getTime() / 1000)): string {
  const v0 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v0=${v0}`;
}

function appWith(webhook: boolean) {
  const queue: OnrampWebhookJobQueue = { enqueueOnrampWebhookReconcile: vi.fn().mockResolvedValue(undefined) };
  const app = createApp({
    databaseProbe: { check: vi.fn() },
    offeringRepository: {
      listPublic: vi.fn().mockResolvedValue([]),
      getInvestorDetail: vi.fn().mockResolvedValue(null),
    },
    logger: pino({ level: "silent" }),
    corsOrigins: [],
    ...(webhook
      ? {
          coinbaseOnrampWebhook: {
            verifier: new CoinbaseOnrampWebhookVerifier(secret, () => now),
            receiveWebhook: new ReceiveCoinbaseOnrampWebhookService(queue),
          },
        }
      : {}),
  });
  return { app, queue };
}

const event = JSON.stringify({
  eventType: "onramp.transaction.success",
  transactionId: "tx_01",
  partnerUserRef: "reservation_01",
  status: "ONRAMP_TRANSACTION_STATUS_SUCCESS",
  walletAddress: "0x0000000000000000000000000000000000000001",
});

function post(app: ReturnType<typeof appWith>["app"], body: string, signature?: string) {
  const call = request(app)
    .post("/webhooks/coinbase-onramp")
    .set("content-type", "application/json")
    .set("x-event-id", "evt_01");
  return (signature === undefined ? call : call.set("x-webhook-signature", signature)).send(body);
}

describe("POST /webhooks/coinbase-onramp", () => {
  it("is not mounted when the webhook secret is not configured", async () => {
    const { app } = appWith(false);
    const response = await post(app, event, sign(event));
    expect(response.status).toBe(404);
  });

  it("verifies the signature over the raw body and enqueues only ids", async () => {
    const { app, queue } = appWith(true);
    const response = await post(app, event, sign(event));
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(queue.enqueueOnrampWebhookReconcile).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      eventId: "evt_01",
      eventType: "onramp.transaction.success",
      traceId: expect.any(String),
    });
  });

  it("accepts the deprecated X-Hook0-Signature header", async () => {
    const { app, queue } = appWith(true);
    const response = await request(app)
      .post("/webhooks/coinbase-onramp")
      .set("content-type", "application/json")
      .set("x-hook0-signature", sign(event))
      .send(event);
    expect(response.status).toBe(200);
    expect(queue.enqueueOnrampWebhookReconcile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["wrong", sign(`${event} `)],
    ["stale", sign(event, Math.floor(now.getTime() / 1000) - 301)],
  ])("rejects a %s signature with the error envelope and enqueues nothing", async (_label, signature) => {
    const { app, queue } = appWith(true);
    const response = await post(app, event, signature);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "offering.coinbase_webhook_invalid", status: 401 });
    expect(response.body.trace_id).toEqual(expect.any(String));
    expect(queue.enqueueOnrampWebhookReconcile).not.toHaveBeenCalled();
  });

  it("rejects a signed body that is not JSON", async () => {
    const { app, queue } = appWith(true);
    const body = "not json";
    const response = await post(app, body, sign(body));
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("offering.coinbase_webhook_payload_invalid");
    expect(queue.enqueueOnrampWebhookReconcile).not.toHaveBeenCalled();
  });

  it.each([
    ["an offramp event", { eventType: "offramp.transaction.success", partnerUserRef: "reservation_01" }],
    ["an event without partnerUserRef", { eventType: "onramp.transaction.success" }],
    ["a foreign partnerUserRef", { eventType: "onramp.transaction.success", partnerUserRef: "user_123" }],
  ])("acknowledges %s without enqueueing", async (_label, payload) => {
    const { app, queue } = appWith(true);
    const body = JSON.stringify(payload);
    const response = await post(app, body, sign(body));
    expect(response.status).toBe(200);
    expect(queue.enqueueOnrampWebhookReconcile).not.toHaveBeenCalled();
  });

  it("enqueues every duplicate delivery; idempotency is enforced when recording", async () => {
    const { app, queue } = appWith(true);
    await post(app, event, sign(event));
    await post(app, event, sign(event));
    expect(queue.enqueueOnrampWebhookReconcile).toHaveBeenCalledTimes(2);
  });
});

describe("ReconcileOnrampWebhookService", () => {
  const reservation = { reservationId: "reservation_01", accountId: "account_01", amountEur: "100.00" } as PendingPurchaseReservationForTimer;
  const job = { reservationId: "reservation_01", eventId: "evt_01", eventType: "onramp.transaction.success", traceId: "req_01" };

  function service(found: PendingPurchaseReservationForTimer | null, recorded: boolean) {
    const reservations = {
      findPendingPurchaseReservationForTimers: vi.fn().mockResolvedValue(found),
    } as unknown as ReservationRepository;
    const poller = {
      reconcileReservation: vi.fn().mockResolvedValue(recorded),
    } as unknown as PollOnrampTransactionsService;
    return { reconcile: new ReconcileOnrampWebhookService(reservations, poller), poller };
  }

  it("re-runs the poll's reconciliation for the one reservation", async () => {
    const { reconcile, poller } = service(reservation, true);
    await expect(reconcile.execute(job)).resolves.toEqual({ status: "recorded", reservation_id: "reservation_01" });
    expect(poller.reconcileReservation).toHaveBeenCalledWith(reservation, "req_01");
  });

  it("reports unchanged when nothing new was recorded (duplicate or still pending)", async () => {
    const { reconcile } = service(reservation, false);
    await expect(reconcile.execute(job)).resolves.toEqual({ status: "unchanged", reservation_id: "reservation_01" });
  });

  it("ignores a reservation that is no longer awaiting its purchase", async () => {
    const { reconcile, poller } = service(null, false);
    await expect(reconcile.execute(job)).resolves.toEqual({ status: "ignored", reservation_id: "reservation_01" });
    expect(poller.reconcileReservation).not.toHaveBeenCalled();
  });

  it("rejects a malformed job payload", async () => {
    const { reconcile } = service(reservation, true);
    await expect(reconcile.execute({ reservationId: 1 })).rejects.toThrow();
  });
});
