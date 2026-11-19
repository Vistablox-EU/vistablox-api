import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { errorResponseSchema } from "../src/shared/http/error-schema.js";
import { requestContext } from "../src/shared/http/request-context.js";
import { captureLogs } from "./support/capture-logs.js";

// Internal wording that must never reach a customer. It is what
// http-coinbase-cdp.client.ts says about a misconfigured key (#72).
const internalText = "The configured Coinbase CDP API key secret is neither a PEM EC key nor a base64 Ed25519 key.";

function appThrowing(error: Error) {
  const logs = captureLogs();
  const app = express();
  app.use(requestContext);
  app.use((_request, response, next) => {
    response.locals.logger = logs.logger;
    next();
  });
  app.get("/boom", () => {
    throw error;
  });
  app.use(errorHandler);
  return { app, logs };
}

describe("error handler", () => {
  it("answers a 5xx AppError with a fixed detail, keeping code, title and trace_id", async () => {
    const { app } = appThrowing(
      new AppError({
        code: "offering.coinbase_provider_key_invalid",
        title: "Onramp unavailable",
        status: 500,
        detail: internalText,
      }),
    );

    const response = await request(app).get("/boom").set("x-trace-id", "req_trace_01");

    expect(response.status).toBe(500);
    expect(errorResponseSchema.parse(response.body)).toMatchObject({
      code: "offering.coinbase_provider_key_invalid",
      title: "Onramp unavailable",
      status: 500,
      detail: "An unexpected error occurred.",
      trace_id: "req_trace_01",
    });
    expect(JSON.stringify(response.body)).not.toContain("PEM EC key");
  });

  it("logs the real message of a 5xx with its trace_id and code, so the masked detail loses nothing", async () => {
    const { app, logs } = appThrowing(
      new AppError({
        code: "offering.coinbase_provider_key_invalid",
        title: "Onramp unavailable",
        status: 500,
        detail: internalText,
      }),
    );

    await request(app).get("/boom").set("x-trace-id", "req_trace_02");

    const entry = logs.entries().find((candidate) => candidate.msg === "request failed");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      level: 50,
      trace_id: "req_trace_02",
      code: "offering.coinbase_provider_key_invalid",
      status: 500,
    });
    expect(entry?.err?.message).toBe(internalText);
  });

  it("tells a 503 apart from other 5xx with a fixed temporary-unavailability sentence", async () => {
    const { app } = appThrowing(
      new AppError({
        code: "offering.coinbase_provider_unavailable",
        title: "Onramp unavailable",
        status: 503,
        detail: "internal: upstream pool exhausted at 10.0.0.7",
      }),
    );

    const response = await request(app).get("/boom");

    expect(response.status).toBe(503);
    expect(response.body.detail).toBe("The service is temporarily unavailable. Please try again later.");
  });

  it("masks a 502 as well", async () => {
    const { app } = appThrowing(
      new AppError({
        code: "offering.coinbase_provider_response_invalid",
        title: "Onramp unavailable",
        status: 502,
        detail: "internal: schema mismatch at token",
      }),
    );

    const response = await request(app).get("/boom");

    expect(response.status).toBe(502);
    expect(response.body.detail).toBe("An unexpected error occurred.");
  });

  it("does not send field errors with a 5xx", async () => {
    const { app } = appThrowing(
      new AppError({
        code: "test.server_fault",
        title: "Server fault",
        status: 500,
        detail: internalText,
        fieldErrors: [{ field: "internal.path", code: "x", message: internalText }],
      }),
    );

    const response = await request(app).get("/boom");

    expect(response.body).not.toHaveProperty("field_errors");
  });

  it("leaves a 4xx detail and field errors untouched", async () => {
    const { app } = appThrowing(
      new AppError({
        code: "offering.reservation_not_available",
        title: "Reservation not available",
        status: 409,
        detail: "This offering is not currently available for a reservation by this account.",
        fieldErrors: [{ field: "reservation", code: "kyc_not_eligible", message: "Identity verification is not currently eligible." }],
      }),
    );

    const response = await request(app).get("/boom");

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      detail: "This offering is not currently available for a reservation by this account.",
      field_errors: [{ field: "reservation", code: "kyc_not_eligible" }],
    });
  });

  it("still turns a request-validation ZodError into a 422 with field errors", async () => {
    const parsed = z.object({ amount_eur: z.string() }).safeParse({});
    if (parsed.success) throw new Error("fixture must fail validation");
    const { app } = appThrowing(parsed.error);

    const response = await request(app).get("/boom");

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: "validation.invalid_field",
      field_errors: [{ field: "amount_eur" }],
    });
  });

  it("keeps masking an unknown error as before", async () => {
    const { app } = appThrowing(new Error(internalText));

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "internal.unexpected", detail: "An unexpected error occurred." });
  });
});
