import { createHmac } from "node:crypto";

import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createKycApp } from "../src/kyc-app.js";
import type { DatabaseProbe } from "../src/infrastructure/database/database-probe.js";
import {
  GetKycAccountForOperationsService,
  GetKycStatusService,
  ReceiveDiditWebhookService,
  StartKycSessionService,
} from "../src/modules/identity/application/kyc.service.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import {
  canonicalize,
  DiditWebhookVerifier,
} from "../src/modules/identity/infrastructure/didit-webhook-verifier.js";
import { InternalApiSignatureVerifier } from "../src/modules/identity/infrastructure/internal-api-signature.js";
import type { KycRepository } from "../src/modules/identity/repository/kyc.repository.js";

const secret = "didit-webhook-secret-for-tests";
const now = new Date("2026-09-01T12:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);

function sign(body: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(canonicalize(body)), "utf8")
    .digest("hex");
}

function fakeKycRepository(overrides: Partial<KycRepository> = {}): KycRepository {
  return {
    getForAccount: vi.fn().mockResolvedValue(null),
    findByDiditReference: vi.fn().mockResolvedValue(null),
    findByProofOfAddressDiditReference: vi.fn().mockResolvedValue(null),
    hasProcessedProviderEvent: vi.fn().mockResolvedValue(false),
    enqueueDiditWebhookProcessing: vi.fn().mockResolvedValue(undefined),
    reserveSessionStart: vi.fn().mockResolvedValue(true),
    completeSessionStart: vi.fn().mockResolvedValue(true),
    failSessionStart: vi.fn().mockResolvedValue(undefined),
    reserveProofOfAddressSessionStart: vi.fn().mockResolvedValue(true),
    completeProofOfAddressSessionStart: vi.fn().mockResolvedValue(true),
    failProofOfAddressSessionStart: vi.fn().mockResolvedValue(undefined),
    applyProviderOutcome: vi.fn().mockResolvedValue("applied"),
    applyProofOfAddressOutcome: vi.fn().mockResolvedValue("applied"),
    recordUnmatchedProviderEvent: vi.fn().mockResolvedValue(undefined),
    getRenewalReminderLeadDays: vi.fn().mockResolvedValue(30),
    listEligibleAccountsForRenewalTimer: vi.fn().mockResolvedValue([]),
    transitionToRequiresRenewal: vi.fn().mockResolvedValue(false),
    listStuckSessionCreationsForTimer: vi.fn().mockResolvedValue([]),
    listStuckOpenSessionsForTimer: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function fakeDiditClient(): DiditClient {
  return { createSession: vi.fn(), getDecision: vi.fn() };
}

function buildApp(options?: { databaseFailure?: boolean; repository?: KycRepository }) {
  const databaseProbe: DatabaseProbe = {
    check:
      options?.databaseFailure === true
        ? vi.fn().mockRejectedValue(new Error("offline"))
        : vi.fn().mockResolvedValue(undefined),
  };
  const repository = options?.repository ?? fakeKycRepository();
  const didit = fakeDiditClient();
  const app = createKycApp({
    databaseProbe,
    logger: pino({ level: "silent" }),
    webhookVerifier: new DiditWebhookVerifier(secret, () => now),
    receiveWebhook: new ReceiveDiditWebhookService(repository),
    internalApiVerifier: new InternalApiSignatureVerifier(
      "an-internal-kyc-api-secret-value-32-chars",
      () => now,
    ),
    getStatus: new GetKycStatusService(repository, didit),
    startSession: new StartKycSessionService(repository, didit, {
      workflowId: "269214fe-77f7-4b1a-a028-b70e861d73c1",
      callbackUrl: "https://app.vistablox.io/kyc/complete",
    }),
    startProofOfAddressSession: undefined,
    getAccountForOperations: new GetKycAccountForOperationsService(repository),
  });
  return { app, repository };
}

const validBody = {
  event_id: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  webhook_type: "status.updated",
  timestamp,
  created_at: timestamp,
  application_id: "c5f501a8-0a32-42cd-ac24-13d0d0b15699",
  environment: "sandbox",
  session_id: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  session_kind: "baseline",
  workflow_id: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  vendor_data: "acct_01",
  status: "Approved",
};

describe("KYC service app", () => {
  it("reports ready when the database is reachable", async () => {
    const { app } = buildApp();
    const response = await request(app).get("/health/ready");
    expect(response.status).toBe(200);
  });

  it("reports not ready when the database is unreachable", async () => {
    const { app } = buildApp({ databaseFailure: true });
    const response = await request(app).get("/health/ready");
    expect(response.status).toBe(503);
  });

  it("accepts a validly-signed webhook and durably enqueues it", async () => {
    const { app, repository } = buildApp();
    const response = await request(app)
      .post("/webhooks/didit")
      .set("x-signature-v2", sign(validBody))
      .set("x-timestamp", String(timestamp))
      .send(validBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(repository.enqueueDiditWebhookProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: validBody.event_id, status: "Approved" }),
    );
  });

  it("rejects a webhook with an invalid signature", async () => {
    const { app, repository } = buildApp();
    const response = await request(app)
      .post("/webhooks/didit")
      .set("x-signature-v2", "0".repeat(64))
      .set("x-timestamp", String(timestamp))
      .send(validBody);

    expect(response.status).toBe(401);
    expect(repository.enqueueDiditWebhookProcessing).not.toHaveBeenCalled();
  });

  it("rejects a webhook with a stale timestamp", async () => {
    const { app, repository } = buildApp();
    const staleTimestamp = timestamp - 301;
    const staleBody = { ...validBody, timestamp: staleTimestamp, created_at: staleTimestamp };
    const response = await request(app)
      .post("/webhooks/didit")
      .set("x-signature-v2", sign(staleBody))
      .set("x-timestamp", String(staleTimestamp))
      .send(staleBody);

    expect(response.status).toBe(401);
    expect(repository.enqueueDiditWebhookProcessing).not.toHaveBeenCalled();
  });
});
