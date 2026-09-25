import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import { AuthorizeSigningRequestService } from "../src/modules/auth/application/authorize-signing-request.service.js";
import {
  DeviceChallengeExpiredError,
  DeviceChallengeReplayedError,
} from "../src/modules/auth/application/device-auth-errors.js";
import {
  SigningRequestAlreadyConsumedError,
  SigningRequestCancelledError,
  SigningRequestExpiredError,
  SigningRequestNotFoundError,
  TxFieldMismatchError,
  TxSignatureInvalidError,
  TxWrongDeviceError,
} from "../src/modules/auth/application/signing-request-errors.js";
import { SIGNING_JWS_PURPOSE } from "../src/modules/auth/domain/signing-request.policy.js";
import type { Device, DeviceRepository } from "../src/modules/auth/repository/device.repository.js";
import type { DeviceChallengeRepository } from "../src/modules/auth/repository/device-challenge.repository.js";
import type {
  SigningRequest,
  SigningRequestRepository,
} from "../src/modules/auth/repository/signing-request.repository.js";

const JWS_TYP = "vistablox-device-auth+jwt";
const ACCOUNT_ID = "acc_1";
const DEVICE_ID = "dev_1";
const DPOP_JKT = "dpop-jkt-1";
const REQUEST_ID = "req_reconfirm";
const CHALLENGE = "challenge-123";
// A fixed date safely ahead of the test runner's clock, so the request's
// stored expiry is always in the future unless a test overrides it.
const CREATED_AT = new Date(Date.now() + 60_000);
const EXPIRES_AT = new Date(Date.now() + 5 * 60_000);

async function deviceWithKey(opts: { deviceId?: string; dpopJkt?: string } = {}): Promise<{
  device: Device;
  privateKey: CryptoKey;
  publicJwk: JWK;
}> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const bioJkt = await calculateJwkThumbprint(publicJwk, "sha256");
  return {
    privateKey,
    publicJwk,
    device: {
      deviceId: opts.deviceId ?? DEVICE_ID,
      accountId: ACCOUNT_ID,
      betterAuthUserId: "user_1",
      dpopJkt: opts.dpopJkt ?? DPOP_JKT,
      bioJkt,
      biometricPublicJwk: publicJwk,
      platform: "android",
      status: "active",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  };
}

function requestRow(overrides: Partial<SigningRequest> = {}): SigningRequest {
  return {
    id: REQUEST_ID,
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

// The JWS kid must equal the thumbprint of the stored public JWK, exactly as
// the device computes it; signing and thumbprint both hang off the same
// `publicJwk` the server will verify against.
async function buildTxJws(input: {
  privateKey: CryptoKey;
  publicJwk: JWK;
  purpose?: string;
  challenge?: string;
  requestId?: string;
  requestType?: string;
  amountMinor?: string;
  currency?: string;
  destination?: { kind: string; value: string };
  createdBy?: { kind: string; label: string };
  createdAt?: string;
  expiresAt?: string;
  iat?: number;
}): Promise<string> {
  // Defaults mirror requestRow() exactly, so a test that just wants a valid
  // signature gets a claim set that matches the stored request field by field.
  const payload: Record<string, unknown> = {
    purpose: input.purpose ?? SIGNING_JWS_PURPOSE,
    challenge: input.challenge ?? CHALLENGE,
    iat: input.iat ?? Math.floor(Date.now() / 1000),
    device_id: DEVICE_ID,
    request_id: input.requestId ?? REQUEST_ID,
    request_type: input.requestType ?? "reservation_reconfirm",
    amount_minor: input.amountMinor ?? "125000",
    currency: input.currency ?? "EUR",
    destination: input.destination ?? { kind: "iban", value: "DE89370400440532013000" },
    created_by: input.createdBy ?? { kind: "user", label: "Damir" },
    created_at: input.createdAt ?? CREATED_AT.toISOString(),
    expires_at: input.expiresAt ?? EXPIRES_AT.toISOString(),
  };

  const kid = await calculateJwkThumbprint(input.publicJwk, "sha256");
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: JWS_TYP, kid })
    .sign(input.privateKey);
}

class FakeDeviceRepository implements DeviceRepository {
  public constructor(private readonly device: Device | null) {}

  public async create(): Promise<Device> {
    throw new Error("not used");
  }
  public async findByDeviceId(deviceId: string): Promise<Device | null> {
    return this.device?.deviceId === deviceId ? this.device : null;
  }
  public async findByDpopJkt(dpopJkt: string): Promise<Device | null> {
    return this.device?.dpopJkt === dpopJkt ? this.device : null;
  }
  public async findActiveDeviceForAccount(): Promise<Device | null> {
    return this.device;
  }
  public async touchLastSeen(): Promise<void> {
    throw new Error("not used");
  }
  public async delete(): Promise<void> {
    throw new Error("not used");
  }
}

class FakeChallengeRepository implements DeviceChallengeRepository {
  public consumed:
    | { challenge: string; purpose: string; dpopJkt: string; deviceId: string | undefined }
    | undefined;
  public replayWindowHit = false;
  private consumedReturns = true;

  public async issue(): Promise<Date> {
    throw new Error("not used");
  }
  public async consume(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
  }): Promise<boolean> {
    this.consumed = input;
    return this.consumedReturns;
  }
  public rejectConsumption(): void {
    this.consumedReturns = false;
  }
  public async wasConsumedWithinReplayWindow(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
  }): Promise<boolean> {
    void input;
    return this.replayWindowHit;
  }
  public async pruneExpired(): Promise<number> {
    throw new Error("not used");
  }
}

class FakeRequestRepository implements SigningRequestRepository {
  public markedAsSigned:
    | { requestId: string; accountId: string; signedJws: unknown; signedAt: Date }
    | undefined;
  public markSignedReturnsNull = false;
  private readonly rows = new Map<string, SigningRequest>();

  public constructor(...rows: SigningRequest[]) {
    for (const row of rows) this.rows.set(row.id, row);
  }

  public async create(): Promise<SigningRequest> {
    throw new Error("not used");
  }
  public async findOwned(requestId: string, accountId: string): Promise<SigningRequest | null> {
    const row = this.rows.get(requestId);
    return row !== undefined && row.accountId === accountId ? row : null;
  }
  public async listForAccount(): Promise<SigningRequest[]> {
    throw new Error("not used");
  }
  public async markSigned(input: {
    requestId: string;
    accountId: string;
    signedJws: unknown;
    signedAt: Date;
  }): Promise<SigningRequest | null> {
    this.markedAsSigned = input;
    if (this.markSignedReturnsNull) return null;
    const found = this.rows.get(input.requestId);
    if (found === undefined) return null;
    const updated: SigningRequest = { ...found, status: "signed", signedJws: input.signedJws, signedAt: input.signedAt };
    this.rows.set(updated.id, updated);
    return updated;
  }
  public async markExecuted(): Promise<SigningRequest | null> {
    throw new Error("not used");
  }
  public async cancelPendingAndSignedForDevice(): Promise<number> {
    throw new Error("not used");
  }
  public async markExpired(): Promise<number> {
    throw new Error("not used");
  }
}

function makeService(input: {
  device?: Device | null;
  challenge?: FakeChallengeRepository;
  requests?: FakeRequestRepository;
  now?: Date;
}) {
  const challenge = input.challenge ?? new FakeChallengeRepository();
  const clock = () => input.now ?? new Date();
  const service = new AuthorizeSigningRequestService(
    challenge,
    new FakeDeviceRepository(input.device ?? null),
    input.requests ?? new FakeRequestRepository(requestRow()),
    clock,
  );
  return { service, challenge };
}

describe("AuthorizeSigningRequestService", () => {
  it("consumes the challenge, verifies the JWS and atomically marks the request signed", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const requests = new FakeRequestRepository(requestRow());
    const challenge = new FakeChallengeRepository();
    const { service } = makeService({ device, challenge, requests });
    const jws = await buildTxJws({ privateKey, publicJwk });

    const result = await service.execute({
      requestId: REQUEST_ID,
      accountId: ACCOUNT_ID,
      dpopJkt: DPOP_JKT,
      challenge: CHALLENGE,
      jws,
    });

    expect(result.status).toBe("signed");
    expect(result.signedJws).toBe(jws);
    expect(requests.markedAsSigned?.requestId).toBe(REQUEST_ID);
    expect(challenge.consumed).toEqual({
      challenge: CHALLENGE,
      purpose: "tx",
      dpopJkt: DPOP_JKT,
      deviceId: DEVICE_ID,
    });
  });

  it("refuses to let the session device sign another device's request as TX_WRONG_DEVICE", async () => {
    // The request lists `dev_a`; the session's DPoP key belongs to `dev_b`.
    const requester = await deviceWithKey({ deviceId: "dev_a" });
    const signer = await deviceWithKey({ deviceId: "dev_b" });
    const { service } = makeService({
      device: signer.device,
      requests: new FakeRequestRepository(requestRow({ deviceId: "dev_a" })),
    });
    const jws = await buildTxJws({ privateKey: signer.privateKey, publicJwk: signer.publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxWrongDeviceError);
  });

  it("refuses when the DPoP key no longer has an active device (revoked) as TX_WRONG_DEVICE", async () => {
    const { privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device: null });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxWrongDeviceError);
  });

  it("refuses a request the account doesn't own (SIGNING_REQUEST_NOT_FOUND)", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device, requests: new FakeRequestRepository() });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(SigningRequestNotFoundError);
  });

  it("refuses an expired-by-stored-data request as REQUEST_EXPIRED", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    // A moment after the fixture's stored expiry -- the lazy-expiry gate.
    const then = new Date(EXPIRES_AT.getTime() + 1);
    const { service } = makeService({
      device,
      requests: new FakeRequestRepository(requestRow({ status: "pending" })),
      now: then,
    });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(SigningRequestExpiredError);
  });

  it("refuses a cancelled request as REQUEST_CANCELLED", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device, requests: new FakeRequestRepository(requestRow({ status: "cancelled" })) });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(SigningRequestCancelledError);
  });

  it("refuses a re-signing of an already-signed request as REQUEST_ALREADY_CONSUMED", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device, requests: new FakeRequestRepository(requestRow({ status: "signed" })) });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(SigningRequestAlreadyConsumedError);
  });

  it("refuses a replayed challenge as DEVICE_CHALLENGE_REPLAYED", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const challenge = new FakeChallengeRepository();
    challenge.rejectConsumption();
    challenge.replayWindowHit = true;
    const { service } = makeService({ device, challenge });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(DeviceChallengeReplayedError);
  });

  it("refuses an expired/unknown challenge as DEVICE_CHALLENGE_EXPIRED", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const challenge = new FakeChallengeRepository();
    challenge.rejectConsumption();
    challenge.replayWindowHit = false;
    const { service } = makeService({ device, challenge });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(DeviceChallengeExpiredError);
  });

  it("rejects a bad signature as TX_SIGNATURE_INVALID", async () => {
    const { device } = await deviceWithKey();
    const other = await deviceWithKey();
    const { service } = makeService({ device });
    // Signed by a key that isn't the stored one -- the wrong-device/jwk case.
    const jws = await buildTxJws({ privateKey: other.privateKey, publicJwk: other.publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxSignatureInvalidError);
  });

  it("rejects a wrong-purpose JWS as TX_SIGNATURE_INVALID", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device });
    const jws = await buildTxJws({ privateKey, publicJwk, purpose: "login" });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxSignatureInvalidError);
  });

  it("rejects a mismatched request_id claim as TX_FIELD_MISMATCH (confused deputy)", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device });
    const jws = await buildTxJws({ privateKey, publicJwk, requestId: "req_another" });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxFieldMismatchError);
  });

  it("rejects a mismatched amount claim as TX_FIELD_MISMATCH", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device });
    const jws = await buildTxJws({ privateKey, publicJwk, amountMinor: "999999" });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxFieldMismatchError);
  });

  it("treats a lost markSigned race as REQUEST_ALREADY_CONSUMED", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const requests = new FakeRequestRepository(requestRow());
    requests.markSignedReturnsNull = true;
    const { service } = makeService({ device, requests });
    const jws = await buildTxJws({ privateKey, publicJwk });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(SigningRequestAlreadyConsumedError);
  });

  it("burns the consumed challenge even when the claims mismatch (no bypass), and challenges are single-use", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const challenge = new FakeChallengeRepository();
    const { service } = makeService({ device, challenge });
    const jws = await buildTxJws({ privateKey, publicJwk, requestId: "req_another" });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxFieldMismatchError);
    expect(challenge.consumed?.challenge).toBe(CHALLENGE);
  });

  it("rejects a JWS over the wrong challenge as TX_SIGNATURE_INVALID", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device });
    const jws = await buildTxJws({ privateKey, publicJwk, challenge: "a-different-challenge" });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxSignatureInvalidError);
  });

  it("rejects a JWS signed by the correct key but for a stale window (iat check)", async () => {
    const { device, privateKey, publicJwk } = await deviceWithKey();
    const { service } = makeService({ device });
    const staleIat = Math.floor(Date.now() / 1000) - 120;
    const jws = await buildTxJws({ privateKey, publicJwk, iat: staleIat });

    await expect(
      service.execute({ requestId: REQUEST_ID, accountId: ACCOUNT_ID, dpopJkt: DPOP_JKT, challenge: CHALLENGE, jws }),
    ).rejects.toBeInstanceOf(TxSignatureInvalidError);
  });
});