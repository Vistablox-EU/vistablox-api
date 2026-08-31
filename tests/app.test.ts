import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { DatabaseProbe } from "../src/infrastructure/database/database-probe.js";
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

function buildApp(options?: { databaseFailure?: boolean; offerings?: PublicOfferingRecord[] }) {
  const databaseProbe: DatabaseProbe = {
    check: options?.databaseFailure === true
      ? vi.fn().mockRejectedValue(new Error("offline"))
      : vi.fn().mockResolvedValue(undefined),
  };
  const listPublic = vi.fn(
    async (input: ListPublicOfferingsInput) =>
      (options?.offerings ?? [offering]).slice(0, input.limit),
  );
  const offeringRepository: OfferingRepository = { listPublic };

  return {
    app: createApp({ databaseProbe, offeringRepository, logger: pino({ level: "silent" }) }),
    databaseProbe,
    listPublic,
  };
}

describe("VistaBlox API", () => {
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
      type: "https://api.vistablox.eu/errors/infrastructure.database_unavailable",
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
      offeringRepository: { listPublic: vi.fn().mockResolvedValue([]) },
      logger: pino({ level: "silent" }),
      authHandler: (request, response) => {
        capturedEventId = request.headers["x-vistablox-auth-event-id"];
        response.status(204).end();
      },
    });

    const response = await request(app)
      .post("/api/auth/sign-in/email")
      .set("x-vistablox-auth-event-id", "attacker-controlled-value");

    expect(response.status).toBe(204);
    expect(capturedEventId).toMatch(/^auth_evt_/);
    expect(capturedEventId).not.toBe("attacker-controlled-value");
  });
});
