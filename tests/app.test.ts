import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { DatabaseProbe } from "../src/infrastructure/database/database-probe.js";
import type { RateLimitStore } from "../src/infrastructure/rate-limit/rate-limit-store.js";
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
  passkeyAssociations?: {
    appleTeamId: string;
    appleBundleId: string;
    androidPackageName: string;
    androidCertificateFingerprints: string[];
  };
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
      ...(options?.passkeyAssociations === undefined
        ? {}
        : { passkeyAssociations: options.passkeyAssociations }),
    }),
    databaseProbe,
    listPublic,
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
      rateLimitStore: store,
    });

    const response = await request(app).get("/v1/offerings?limit=20");

    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ code: "rate_limit.exceeded", status: 429 });
  });
});
