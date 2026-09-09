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
  StartProofOfAddressSessionService,
} from "../src/modules/identity/application/kyc.service.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import { DiditWebhookVerifier } from "../src/modules/identity/infrastructure/didit-webhook-verifier.js";
import {
  InternalApiSignatureVerifier,
  signInternalRequest,
} from "../src/modules/identity/infrastructure/internal-api-signature.js";
import type {
  KycEligibilityRecord,
  KycRepository,
} from "../src/modules/identity/repository/kyc.repository.js";

const secret = "an-internal-kyc-api-secret-value-32-chars";
const now = new Date("2026-09-01T12:00:00.000Z");

const eligibleRecord: KycEligibilityRecord = {
  accountId: "acct_01",
  diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  eligibilityState: "eligible",
  operationalSubstatus: "kyc_verified",
  proofOfAddressDiditReference: null,
  proofOfAddressProviderStatus: null,
  proofOfAddressProviderUpdatedAt: null,
  proofOfAddressStatus: "not_started",
  residenceCountryCode: "DE",
  taxResidenceCountryCode: "DE",
  proofOfAddressCurrentUntil: null,
  lastVerifiedAt: null,
  everRequiredManualReview: false,
  renewalDueAt: null,
};

function fakeKycRepository(overrides: Partial<KycRepository> = {}): KycRepository {
  return {
    getForAccount: vi.fn().mockResolvedValue(eligibleRecord),
    findByDiditReference: vi.fn().mockResolvedValue(null),
    findByProofOfAddressDiditReference: vi.fn().mockResolvedValue(null),
    hasProcessedProviderEvent: vi.fn().mockResolvedValue(false),
    enqueueDiditWebhookProcessing: vi.fn().mockResolvedValue(undefined),
    reserveSessionStart: vi.fn().mockResolvedValue(false),
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

function buildApp(options?: { repository?: KycRepository; withProofOfAddress?: boolean }) {
  const repository = options?.repository ?? fakeKycRepository();
  const didit = fakeDiditClient();
  const databaseProbe: DatabaseProbe = { check: vi.fn().mockResolvedValue(undefined) };
  const app = createKycApp({
    databaseProbe,
    logger: pino({ level: "silent" }),
    webhookVerifier: new DiditWebhookVerifier("didit-webhook-secret-for-test"),
    receiveWebhook: new ReceiveDiditWebhookService(repository),
    internalApiVerifier: new InternalApiSignatureVerifier(secret, () => now),
    getStatus: new GetKycStatusService(repository, didit),
    startSession: new StartKycSessionService(repository, didit, {
      workflowId: "269214fe-77f7-4b1a-a028-b70e861d73c1",
      callbackUrl: "https://app.vistablox.io/kyc/complete",
    }),
    startProofOfAddressSession:
      options?.withProofOfAddress === false
        ? undefined
        : new StartProofOfAddressSessionService(repository, didit, {
            workflowId: "bb17fe44-5b38-48f3-acb7-39dbc38c9317",
            callbackUrl: "https://app.vistablox.io/kyc/complete",
          }),
    getAccountForOperations: new GetKycAccountForOperationsService(repository),
  });
  return { app, repository };
}

function signed(method: string, path: string, body?: unknown) {
  return signInternalRequest({ secret, method, path, body, now });
}

describe("KYC service internal API", () => {
  it("accepts a validly-signed status lookup", async () => {
    const { app } = buildApp();
    const path = "/internal/kyc/status?account_id=acct_01";
    const { signature, timestamp } = signed("GET", path);

    const response = await request(app)
      .get(path)
      .set("x-internal-signature", signature)
      .set("x-internal-timestamp", timestamp);

    expect(response.status).toBe(200);
    expect(response.body.data.eligibility_state).toBe("eligible");
  });

  it("accepts a validly-signed account lookup", async () => {
    const { app } = buildApp();
    const path = "/internal/kyc/accounts/acct_01";
    const { signature, timestamp } = signed("GET", path);

    const response = await request(app)
      .get(path)
      .set("x-internal-signature", signature)
      .set("x-internal-timestamp", timestamp);

    expect(response.status).toBe(200);
    expect(response.body.data.account_id).toBe("acct_01");
  });

  it.each([
    { name: "missing signature", headers: {} as Record<string, string> },
    { name: "wrong secret", headers: (() => signInternalRequest({ secret: "a-different-secret-value-32-chars", method: "GET", path: "/internal/kyc/status?account_id=acct_01", now }))() },
    { name: "tampered path", headers: (() => signInternalRequest({ secret, method: "GET", path: "/internal/kyc/status?account_id=acct_99", now }))() },
    { name: "stale timestamp", headers: (() => signInternalRequest({ secret, method: "GET", path: "/internal/kyc/status?account_id=acct_01", now: new Date(now.getTime() - 61_000) }))() },
  ])("rejects a request with $name", async ({ headers }) => {
    const { app } = buildApp();
    const path = "/internal/kyc/status?account_id=acct_01";
    const call = request(app).get(path);
    if ("signature" in headers) {
      call.set("x-internal-signature", headers.signature).set("x-internal-timestamp", headers.timestamp);
    }

    const response = await call;
    expect(response.status).toBe(401);
  });

  it("validates the request body -- malformed account_id", async () => {
    const { app } = buildApp();
    const body = { account_id: "", trace_id: "trace_1", residence_country_code: "DE", tax_residence_country_code: "DE" };
    const path = "/internal/kyc/sessions";
    const { signature, timestamp } = signed("POST", path, body);

    const response = await request(app)
      .post(path)
      .set("x-internal-signature", signature)
      .set("x-internal-timestamp", timestamp)
      .send(body);

    expect(response.status).toBe(422);
  });

  it("passes a business-rule conflict through unchanged", async () => {
    const { app } = buildApp({ repository: fakeKycRepository({ reserveSessionStart: vi.fn().mockResolvedValue(false) }) });
    const body = { account_id: "acct_01", trace_id: "trace_1", residence_country_code: "DE", tax_residence_country_code: "DE" };
    const path = "/internal/kyc/sessions";
    const { signature, timestamp } = signed("POST", path, body);

    const response = await request(app)
      .post(path)
      .set("x-internal-signature", signature)
      .set("x-internal-timestamp", timestamp)
      .send(body);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("identity.kyc_session_unavailable");
  });

  it("reports proof-of-address as not configured when this deployment has no workflow for it", async () => {
    const { app } = buildApp({ withProofOfAddress: false });
    const body = { account_id: "acct_01", trace_id: "trace_1" };
    const path = "/internal/kyc/proof-of-address/sessions";
    const { signature, timestamp } = signed("POST", path, body);

    const response = await request(app)
      .post(path)
      .set("x-internal-signature", signature)
      .set("x-internal-timestamp", timestamp)
      .send(body);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("identity.proof_of_address_not_configured");
  });
});
