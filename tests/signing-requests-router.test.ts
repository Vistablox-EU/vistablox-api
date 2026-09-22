import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createSigningRequestsRouter } from "../src/modules/auth/api/signing-requests.router.js";
import type { AuthContext } from "../src/modules/auth/api/auth-context.js";
import { IssueDeviceChallengeService } from "../src/modules/auth/application/device-challenge-issuance.service.js";
import { TxSignatureInvalidError } from "../src/modules/auth/application/signing-request-errors.js";
import type { DeviceChallengeRepository } from "../src/modules/auth/repository/device-challenge.repository.js";
import type { DeviceRepository } from "../src/modules/auth/repository/device.repository.js";
import type { SigningRequestRepository } from "../src/modules/auth/repository/signing-request.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const ACCOUNT_ID = "acc_1";
const DPOP_JKT = "dpop-jkt-1";
const DEVICE_ID = "dev_1";
// Fixed dates safely ahead of the runner's clock so default rows are always
// challengeable/ownable, unless a test overrides the expiry.
const CREATED_AT = new Date(Date.now() + 60_000);
const EXPIRES_AT = new Date(Date.now() + 5 * 60_000);

function fakeChallengeRepository(expiresAt: Date): DeviceChallengeRepository {
  return {
    issue: vi.fn().mockResolvedValue(expiresAt),
    consume: vi.fn().mockResolvedValue(true),
    wasConsumedWithinReplayWindow: vi.fn().mockResolvedValue(false),
    pruneExpired: vi.fn().mockResolvedValue(0),
  };
}

function requestRow(overrides: Record<string, unknown> = {}): object {
  return {
    id: "req_reconfirm",
    accountId: ACCOUNT_ID,
    deviceId: DEVICE_ID,
    requestType: "reservation_reconfirm",
    amountMinor: "125000",
    currency: "EUR",
    destination: { kind: "iban", value: "DE89370400440532013000" },
    createdBy: { kind: "user", label: "Damir" },
    status: "pending",
    signedJws: null,
    signedAt: null,
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function fakeDeviceRepository(device: object | null): Pick<DeviceRepository, "findByDpopJkt"> {
  return { findByDpopJkt: vi.fn().mockResolvedValue(device) };
}

function devicesfor(device: object | null): Pick<DeviceRepository, "findByDpopJkt"> {
  return fakeDeviceRepository(device);
}

function fakeRequestRepository(): SigningRequestRepository {
  return {
    create: vi.fn(),
    findOwned: vi.fn().mockResolvedValue(requestRow()),
    listForAccount: vi.fn().mockResolvedValue([requestRow()]),
    markSigned: vi.fn().mockResolvedValue(null),
    markExecuted: vi.fn().mockResolvedValue(null),
    cancelPendingAndSignedForDevice: vi.fn().mockResolvedValue(0),
    markExpired: vi.fn().mockResolvedValue(0),
  };
}

function appFor(input: {
  requests?: SigningRequestRepository;
  devices?: Pick<DeviceRepository, "findByDpopJkt">;
  authorize?: unknown;
  authContext?: AuthContext;
}) {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  const requireAuthentication: RequestHandler = (_request, response, next) => {
    response.locals.authContext = (input.authContext ?? {
      accountId: ACCOUNT_ID,
      dpopJkt: DPOP_JKT,
      providerSessionId: "provider-session-1",
      population: "customer",
    }) as AuthContext;
    next();
  };
  const requests = input.requests ?? fakeRequestRepository();
  const devices = input.devices ?? fakeDeviceRepository({ deviceId: DEVICE_ID });
  const authorize = (input.authorize ?? { execute: vi.fn().mockResolvedValue({ status: "signed" }) }) as never;
  const issues = new IssueDeviceChallengeService(fakeChallengeRepository(new Date("2026-09-01T10:02:00.000Z")));
  app.use(
    "/v1/auth/signing-requests",
    createSigningRequestsRouter({ requireAuthentication, issues, devices, requests, authorizes: authorize }),
  );
  app.use(errorHandler);
  return app;
}

describe("T1 GET /v1/auth/signing-requests", () => {
  it("lists the account's pending requests by default, newest first", async () => {
    const requests = fakeRequestRepository();
    const response = await request(appFor({ requests })).get("/v1/auth/signing-requests");

    expect(response.status).toBe(200);
    expect((requests.listForAccount as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([ACCOUNT_ID, "pending"]);
    expect(response.body).toEqual({
      data: [
        {
          request_id: "req_reconfirm",
          request_type: "reservation_reconfirm",
          amount_minor: "125000",
          currency: "EUR",
          destination: { kind: "iban", value: "DE89370400440532013000" },
          created_by: { kind: "user", label: "Damir" },
          created_at: CREATED_AT.toISOString(),
          expires_at: EXPIRES_AT.toISOString(),
          status: "pending",
        },
      ],
    });
  });

  it("honours an explicit ?status= filter", async () => {
    const requests = fakeRequestRepository();
    const response = await request(appFor({ requests })).get("/v1/auth/signing-requests?status=signed");

    expect(response.status).toBe(200);
    expect((requests.listForAccount as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([ACCOUNT_ID, "signed"]);
  });

  it("rejects an un-filterable status with the validation envelope", async () => {
    const response = await request(appFor({})).get("/v1/auth/signing-requests?status=included");

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("validation.invalid_field");
  });
});

describe("T1 GET /v1/auth/signing-requests/:request_id", () => {
  it("returns one owned request", async () => {
    const requests = fakeRequestRepository();
    const response = await request(appFor({ requests })).get("/v1/auth/signing-requests/req_reconfirm");

    expect(response.status).toBe(200);
    expect(response.body.data.request_id).toBe("req_reconfirm");
    expect((requests.findOwned as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith("req_reconfirm", ACCOUNT_ID);
  });

  it("answers SIGNING_REQUEST_NOT_FOUND (404) for another account's request", async () => {
    const requests = fakeRequestRepository();
    (requests.findOwned as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const response = await request(appFor({ requests })).get("/v1/auth/signing-requests/req_reconfirm");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("SIGNING_REQUEST_NOT_FOUND");
  });
});

describe("T2 POST /v1/auth/signing-requests/:request_id/challenge", () => {
  it("issues a tx challenge bound to the session's device once the request is challengeable", async () => {
    const requests = fakeRequestRepository();
    const device = { deviceId: DEVICE_ID };
    const response = await request(appFor({ requests, devices: devicesfor(device) }))
      .post("/v1/auth/signing-requests/req_reconfirm/challenge")
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      challenge: expect.any(String),
      expires_at: "2026-09-01T10:02:00.000Z",
    });
  });

  it("refuses a challenge for another device's request as TX_WRONG_DEVICE (403)", async () => {
    const device = { deviceId: "dev_other" };
    const authorize = {};
    const response = await request(appFor({ devices: devicesfor(device), authorize }))
      .post("/v1/auth/signing-requests/req_reconfirm/challenge")
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("TX_WRONG_DEVICE");
  });

  it("refuses a challenge for an expired-now request as REQUEST_EXPIRED (409)", async () => {
    const requests = fakeRequestRepository();
    (requests.findOwned as ReturnType<typeof vi.fn>).mockResolvedValue(
      requestRow({ expiresAt: new Date("2026-09-01T09:59:00.000Z") }),
    );
    const response = await request(appFor({ requests }))
      .post("/v1/auth/signing-requests/req_reconfirm/challenge")
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("REQUEST_EXPIRED");
  });

  it("answers SIGNING_REQUEST_NOT_FOUND when the account doesn't own the request", async () => {
    const requests = fakeRequestRepository();
    (requests.findOwned as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const response = await request(appFor({ requests }))
      .post("/v1/auth/signing-requests/req_reconfirm/challenge")
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("SIGNING_REQUEST_NOT_FOUND");
  });

  it("halts with a 500 when the session carries no DPoP binding", async () => {
    const response = await request(
      appFor({
        authContext: {
          accountId: ACCOUNT_ID,
          providerSessionId: "provider-session-1",
          population: "customer",
        } as AuthContext,
      }),
    ).post("/v1/auth/signing-requests/req_reconfirm/challenge").send({});

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("internal.dpop_jkt_missing");
  });
});

const SIGN_BODY = {
  challenge: "challenge-123",
  jws: "eyJhbGciOiJFUzI1NiIsInR5cCI6InZpc3RhYmxveC1kZXZpY2UtYXV0aCtqd3QifQ.eyJwIjoieCJ9.sig",
  attestation: { platform: "android", key_attestation_chain: ["cert1"] },
};

describe("T3 POST /v1/auth/signing-requests/:request_id/sign", () => {
  it("returns the request's resulting status after the ceremony (signed this phase)", async () => {
    const authorize = { execute: vi.fn().mockResolvedValue({ status: "signed" }) };
    const response = await request(appFor({ authorize }))
      .post("/v1/auth/signing-requests/req_reconfirm/sign")
      .send(SIGN_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: "signed" } });
  });

  it("relays TX_SIGNATURE_INVALID as 401", async () => {
    const authorize = {
      execute: vi.fn().mockRejectedValue(new TxSignatureInvalidError("bad signature")),
    };
    const response = await request(appFor({ authorize }))
      .post("/v1/auth/signing-requests/req_reconfirm/sign")
      .send(SIGN_BODY);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("TX_SIGNATURE_INVALID");
  });

  it("answers 422 for a missing attestation (the contract requires one on every signing action)", async () => {
    const response = await request(appFor({}))
      .post("/v1/auth/signing-requests/req_reconfirm/sign")
      .send({ challenge: "challenge-123", jws: "x.y.z" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("validation.invalid_field");
  });
});