import { createHmac } from "node:crypto";

import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { DatabaseProbe } from "../src/infrastructure/database/database-probe.js";
import type { RateLimitStore } from "../src/infrastructure/rate-limit/rate-limit-store.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import {
  GetKycAccountForOperationsService,
  GetKycStatusService,
  ReceiveDiditWebhookService,
  StartKycSessionService,
} from "../src/modules/identity/application/kyc.service.js";
import {
  canonicalize,
  DiditWebhookVerifier,
} from "../src/modules/identity/infrastructure/didit-webhook-verifier.js";
import type { KycRepository } from "../src/modules/identity/repository/kyc.repository.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";
import type {
  ListPublicOfferingsInput,
  OfferingRepository,
  PublicOfferingRecord,
} from "../src/modules/offering/repository/offering.repository.js";

const offering: PublicOfferingRecord = {
  id: "off_01",
  status: "pre_offering",
  targetRaiseEur: "250000.00",
  createdAt: new Date("2026-08-31T12:00:00.000Z"),
  ipoEndAt: new Date("2026-10-31T12:00:00.000Z"),
  property: {
    propertyType: "residential",
    countryCode: "RS",
    city: "Belgrade",
  },
};

function buildApp(options?: {
  databaseFailure?: boolean;
  offerings?: PublicOfferingRecord[];
  corsOrigins?: string[];
  passkeyAssociations?: {
    appleTeamId: string;
    appleBundleId: string;
    androidPackageName: string;
    androidCertificateFingerprints: string[];
  };
  webauthnRelatedOrigins?: string[];
}) {
  const databaseProbe: DatabaseProbe = {
    check: options?.databaseFailure === true
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(undefined),
  };
  const listPublic = vi.fn(
    async (input: ListPublicOfferingsInput) =>
      (options?.offerings ?? [offering]).slice(0, input.limit),
  );
  const offeringRepository: OfferingRepository = {
    listPublic,
    getInvestorDetail: vi.fn().mockResolvedValue(null),
  };

  return {
    app: createApp({
      databaseProbe,
      offeringRepository,
      logger: pino({ level: "silent" }),
      corsOrigins: options?.corsOrigins ?? [],
      ...(options?.passkeyAssociations === undefined
        ? {}
        : { passkeyAssociations: options.passkeyAssociations }),
      ...(options?.webauthnRelatedOrigins === undefined
        ? {}
        : { webauthnRelatedOrigins: options.webauthnRelatedOrigins }),
    }),
    databaseProbe,
    listPublic,
  };
}

const webhookSecret = "didit-webhook-secret-for-tests";
const webhookNow = new Date("2026-09-01T12:00:00.000Z");
const webhookTimestamp = Math.floor(webhookNow.getTime() / 1_000);

function signWebhook(body: unknown): string {
  return createHmac("sha256", webhookSecret)
    .update(JSON.stringify(canonicalize(body)), "utf8")
    .digest("hex");
}

const validWebhookBody = {
  event_id: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  webhook_type: "status.updated",
  timestamp: webhookTimestamp,
  created_at: webhookTimestamp,
  application_id: "c5f501a8-0a32-42cd-ac24-13d0d0b15699",
  environment: "sandbox",
  session_id: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  session_kind: "baseline",
  workflow_id: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  vendor_data: "acct_01",
  status: "Approved",
};

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

// /webhooks/didit doesn't use any of protectedApi's other fields (it's
// unauthenticated), but AppDependencies.protectedApi requires them all
// once provided at all -- these are never exercised by the test below.
function fakeOriginationRepository(): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn().mockResolvedValue([]),
    getOwnedCase: vi.fn().mockResolvedValue(null),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn().mockResolvedValue([]),
    getCaseForOperations: vi.fn().mockResolvedValue(null),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn().mockResolvedValue(null),
    listOwnedInformationRequests: vi.fn().mockResolvedValue(null),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    expireInformationRequest: vi.fn().mockResolvedValue(false),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn().mockResolvedValue([]),
    postCaseMessage: vi.fn(),
    getCasePartnerAssignment: vi.fn().mockResolvedValue(null),
    assignPartnerOrganization: vi.fn().mockResolvedValue(null),
    listCasesForPartner: vi.fn().mockResolvedValue([]),
    getCaseForPartner: vi.fn().mockResolvedValue(null),
    recordLegalStructuring: vi.fn().mockResolvedValue(null),
    recordAppraisal: vi.fn().mockResolvedValue(null),
  };
}

describe("VistaBlox API", () => {
  it("serves native app association metadata for passkeys", async () => {
    const { app } = buildApp({
      passkeyAssociations: {
        appleTeamId: "TEAM123",
        appleBundleId: "com.vistablox.app",
        androidPackageName: "com.vistablox.app",
        androidCertificateFingerprints: ["AA:BB:CC"],
      },
    });

    const [apple, android] = await Promise.all([
      request(app).get("/.well-known/apple-app-site-association"),
      request(app).get("/.well-known/assetlinks.json"),
    ]);

    expect(apple.status).toBe(200);
    expect(apple.body).toEqual({ webcredentials: { apps: ["TEAM123.com.vistablox.app"] } });
    expect(android.status).toBe(200);
    expect(android.body[0]).toMatchObject({
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        package_name: "com.vistablox.app",
        sha256_cert_fingerprints: ["AA:BB:CC"],
      },
    });
  });

  it("serves the WebAuthn related origins as public, cacheable JSON", async () => {
    // Which origins count as related (not the rpId's own host) is decided
    // by resolveWebAuthnSettings -- see webauthn-environment.test.ts.
    const { app } = buildApp({
      corsOrigins: ["https://admin.vistablox.io"],
      webauthnRelatedOrigins: ["https://admin.vistablox.io"],
    });

    // Sent as the admin console's browser would (a trusted CORS origin), to
    // check the public, credential-free headers win over the global CORS ones.
    const response = await request(app)
      .get("/.well-known/webauthn")
      .set("Origin", "https://admin.vistablox.io");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
    expect(response.headers["access-control-allow-origin"]).toBe("*");
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(response.body).toEqual({ origins: ["https://admin.vistablox.io"] });
  });

  it("404s the WebAuthn related origins file when there's nothing to list", async () => {
    const onlyRpOrigin = buildApp({ webauthnRelatedOrigins: [] });
    const unconfigured = buildApp();

    const [first, second] = await Promise.all([
      request(onlyRpOrigin.app).get("/.well-known/webauthn"),
      request(unconfigured.app).get("/.well-known/webauthn"),
    ]);

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
  });

  it("allows a credentialed cross-origin request from a trusted frontend origin", async () => {
    const { app } = buildApp({ corsOrigins: ["https://admin.vistablox.io"] });

    const response = await request(app)
      .get("/health/live")
      .set("Origin", "https://admin.vistablox.io");

    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://admin.vistablox.io",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("omits CORS headers for a browser origin that isn't trusted", async () => {
    const { app } = buildApp({ corsOrigins: ["https://admin.vistablox.io"] });

    const response = await request(app)
      .get("/health/live")
      .set("Origin", "https://evil.example.com");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reports liveness without touching the database", async () => {
    const { app, databaseProbe } = buildApp();

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(databaseProbe.check).not.toHaveBeenCalled();
  });

  it("reports database readiness failures with the stable error envelope", async () => {
    const { app } = buildApp({ databaseFailure: true });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      type: "https://api.vistablox.io/errors/infrastructure.database_unavailable",
      code: "infrastructure.database_unavailable",
      title: "Service unavailable",
      status: 503,
      detail: "The database dependency is unavailable.",
    });
    expect(response.body.trace_id).toMatch(/^req_/);
  });

  it("returns the public offering teaser contract", async () => {
    const { app, listPublic } = buildApp();

    const response = await request(app).get("/v1/offerings?limit=20");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [
        {
          id: "off_01",
          status: "pre_offering",
          target_raise_eur: "250000.00",
          ipo_end_at: "2026-10-31T12:00:00.000Z",
          property: {
            property_type: "residential",
            country_code: "RS",
            city: "Belgrade",
          },
        },
      ],
      page: { next_cursor: null },
    });
    expect(listPublic).toHaveBeenCalledWith({ limit: 21 });
  });

  it("rejects invalid pagination inputs as field errors", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/v1/offerings?limit=1000");

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: "validation.invalid_field",
      status: 422,
      field_errors: [
        {
          field: "limit",
          code: "too_big",
        },
      ],
    });
  });

  it("returns the stable 404 contract for unknown routes", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/v1/unknown");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: "resource.not_found",
      status: 404,
    });
  });

  it("overwrites client-provided auth event IDs before Better Auth receives them", async () => {
    let capturedEventId: string | string[] | undefined;
    const app = createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      authHandler: (request, response) => {
        capturedEventId = request.headers["x-vistablox-auth-event-id"];
        response.status(204).end();
      },
    });

    const response = await request(app)
      .post("/api/auth/sign-in/social")
      .set("x-vistablox-auth-event-id", "attacker-controlled-value");

    expect(response.status).toBe(204);
    expect(capturedEventId).toMatch(/^auth_evt_/);
    expect(capturedEventId).not.toBe("attacker-controlled-value");
  });

  it("applies the tightened rate limit tier ahead of Better Auth's own endpoints", async () => {
    const store: RateLimitStore = { increment: vi.fn().mockResolvedValue(11) };
    const app = createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      authHandler: (_request, response) => response.status(204).end(),
      rateLimitStore: store,
    });

    const response = await request(app).post("/api/auth/sign-in/social");

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: "rate_limit.exceeded", status: 429 });
  });

  it.each([
    "/api/auth/sign-in/email",
    "/api/auth/sign-up/email",
    "/api/auth/change-password",
    "/api/auth/email-otp/send-verification-otp",
    "/api/auth/sign-in/email-otp",
    "/api/auth/email-otp/request-password-reset",
    "/api/auth/email-otp/reset-password",
  ])("does not expose credential route %s", async (path) => {
    const authHandler = vi.fn((_request, response) => response.status(204).end());
    const app = createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      authHandler,
    });

    const response = await request(app).post(path);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "resource.not_found" });
    expect(authHandler).not.toHaveBeenCalled();
  });

  it("applies the baseline rate limit tier to the public offerings endpoint", async () => {
    const store: RateLimitStore = { increment: vi.fn().mockResolvedValue(301) };
    const app = createApp({
      databaseProbe: { check: vi.fn().mockResolvedValue(undefined) },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      rateLimitStore: store,
    });

    const response = await request(app).get("/v1/offerings?limit=20");

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: "rate_limit.exceeded", status: 429 });
  });

  // This route used to live only in src/kyc-app.ts. Its verifier's own
  // accept/reject/stale-timestamp logic is already covered in detail by
  // didit-webhook-verifier.test.ts -- what matters here is the route wiring
  // itself (middleware order, express.json() mounted ahead of it, the right
  // path), not re-proving the verifier.
  it("accepts a validly-signed Didit webhook and durably enqueues it", async () => {
    const repository = fakeKycRepository();
    const didit = fakeDiditClient();
    const workflowId = "269214fe-77f7-4b1a-a028-b70e861d73c1";
    const callbackUrl = "https://app.vistablox.io/kyc/complete";
    const sessions: SessionResolver = { resolve: vi.fn().mockResolvedValue(null) };
    const accounts: AccountRepository = {
      findByBetterAuthUserId: vi.fn().mockResolvedValue(null),
      hasActiveStaffRole: vi.fn().mockResolvedValue(false),
      hasAnyActiveStaffRole: vi.fn().mockResolvedValue(false),
      provision: vi.fn(),
      syncVerifiedContactEmail: vi.fn(),
      getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
    };
    const app = createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      protectedApi: {
        accounts,
        sessions,
        originationRepository: fakeOriginationRepository(),
        staffWebAuthnRepository: {
          listCredentials: vi.fn().mockResolvedValue([]),
          findCredential: vi.fn().mockResolvedValue(null),
          isSessionVerified: vi.fn().mockResolvedValue(false),
          replaceChallenge: vi.fn(),
          getActiveChallenge: vi.fn().mockResolvedValue(null),
          failChallenge: vi.fn().mockResolvedValue(false),
          completeRegistration: vi.fn().mockResolvedValue(false),
          completeAuthentication: vi.fn().mockResolvedValue(false),
        },
        staffWebAuthnCeremony: {
          generateRegistrationOptions: vi.fn(),
          verifyRegistration: vi.fn(),
          generateAuthenticationOptions: vi.fn(),
          verifyAuthentication: vi.fn(),
        },
        kyc: {
          getStatus: new GetKycStatusService(repository, didit),
          startSession: new StartKycSessionService(repository, didit, { workflowId, callbackUrl }),
          startProofOfAddressSession: undefined,
          getAccountForOperations: new GetKycAccountForOperationsService(repository),
          webhookVerifier: new DiditWebhookVerifier(webhookSecret, () => webhookNow),
          receiveWebhook: new ReceiveDiditWebhookService(repository),
        },
      },
    });

    const response = await request(app)
      .post("/webhooks/didit")
      .set("x-signature-v2", signWebhook(validWebhookBody))
      .set("x-timestamp", String(webhookTimestamp))
      .send(validWebhookBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
    expect(repository.enqueueDiditWebhookProcessing).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: validWebhookBody.event_id, status: "Approved" }),
    );
  });
});
