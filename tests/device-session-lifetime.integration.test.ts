import { createHash, randomUUID, webcrypto } from "node:crypto";

import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import { createDeviceAuthRouter } from "../src/modules/auth/api/device-auth.router.js";
import { createRequireAuthentication } from "../src/modules/auth/api/require-authentication.js";
import { createRequireDpopOnly } from "../src/modules/auth/api/require-dpop-only.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import { IssueDeviceChallengeService } from "../src/modules/auth/application/device-challenge-issuance.service.js";
import { LoginDeviceService } from "../src/modules/auth/application/device-login.service.js";
import { BetterAuthSessionResolver } from "../src/modules/auth/infrastructure/better-auth-session.resolver.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaSessionMirror } from "../src/modules/auth/infrastructure/prisma-session-mirror.js";
import { PrismaAuthAuditSink } from "../src/modules/auth/repository/prisma-auth-audit-sink.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";
import { PrismaDpopReplayRepository } from "../src/modules/auth/repository/prisma-dpop-replay.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const SECRET = "integration-test-secret-that-is-at-least-32-characters";
const MINUTE = 60_000;
const PROTECTED_PATH = "/v1/test/protected";

interface SessionRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

// Device-session time limits (contract 3.6/3.7) end to end: a real device
// login (L1 + L2) through the real /v1 router and a real createBetterAuth
// instance, then real /v1 requests through requireAuthentication with the
// real BetterAuthSessionResolver, against Postgres. No stubbed auth.api.
// Time is moved by rewriting the session row's timestamps, since the server
// compares them with its own clock.
describe.skipIf(databaseUrl === undefined)("device session time limits, real stack", () => {
  const suffix = randomUUID();
  const email = `device-session-lifetime-${suffix}@example.test`;
  const accountId = `acct_${suffix}`;
  const deviceId = `device_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const deviceChallengeRepository = new PrismaDeviceChallengeRepository(database);
  const deviceRepository = new PrismaDeviceRepository(database);
  const dpopReplayRepository = new PrismaDpopReplayRepository(database);
  const accountRepository = new PrismaAccountRepository(database);
  const sessionMirror = new PrismaSessionMirror(database, SECRET);

  let betterAuthUserId = "";
  let deviceBioJkt = "";
  let devicePrivateKey: webcrypto.CryptoKey;
  let dpopKeyPair: { privateKey: webcrypto.CryptoKey; publicJwk: JWK };
  let testApp: express.Express;

  beforeAll(async () => {
    const auth = createBetterAuth({
      database: authPool,
      baseURL: BASE_URL,
      secret: SECRET,
      secureCookies: false,
      trustedOrigins: [BASE_URL],
      authAuditSink: new PrismaAuthAuditSink(database),
      sessionMirror,
      dpop: { baseUrl: BASE_URL, replayRepository: dpopReplayRepository },
      deviceAuth: {
        accounts: accountRepository,
        enrolDevice: new EnrolDeviceService(deviceChallengeRepository, deviceRepository, {
          policy: "disabled",
          pinnedRootCertificates: [],
          certDigestAllowlist: [],
          revocationList: { isRevoked: async () => false },
          playIntegrityDecoder: undefined,
        }),
        loginDevice: new LoginDeviceService(deviceChallengeRepository, deviceRepository),
      },
    });

    const authContext = await auth.$context;
    const createdUser = await authContext.internalAdapter.createUser(
      { name: "Device Session Lifetime Test", email, emailVerified: true },
      { method: "internal" },
    );
    betterAuthUserId = createdUser.id;
    await database.account.create({ data: { id: accountId, betterAuthUserId, status: "active" } });

    const deviceKeys = await generateKeyPair();
    devicePrivateKey = deviceKeys.privateKey;
    deviceBioJkt = await calculateJwkThumbprint(deviceKeys.publicJwk, "sha256");
    dpopKeyPair = await generateKeyPair();
    // Seeded with the thumbprint of the DPoP key the test logs in with:
    // LoginDeviceService only accepts L2 from the device's own DPoP key.
    await database.device.create({
      data: {
        deviceId,
        accountId,
        betterAuthUserId,
        dpopJkt: await calculateJwkThumbprint(dpopKeyPair.publicJwk, "sha256"),
        bioJkt: deviceBioJkt,
        biometricPublicJwk: deviceKeys.publicJwk as object,
        platform: "android",
        attestationMetadata: {},
      },
    });

    const requireDpopOnly = createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository });
    const requireDpopOnlyForVerify = createRequireDpopOnly({
      baseUrl: BASE_URL,
      replayRepository: dpopReplayRepository,
      recordReplays: false,
    });
    const requireAuthentication = createRequireAuthentication(
      new BetterAuthSessionResolver(auth, authPool, { sessionMirror }),
      accountRepository,
      undefined,
      { baseUrl: BASE_URL, replayRepository: dpopReplayRepository },
    );

    testApp = express();
    testApp.use(express.json());
    testApp.use(requestContext);
    testApp.use(
      "/v1/auth/devices",
      createDeviceAuthRouter(
        requireDpopOnly,
        new IssueDeviceChallengeService(deviceChallengeRepository),
        auth,
        requireDpopOnlyForVerify,
      ),
    );
    testApp.get(PROTECTED_PATH, requireAuthentication, (_request, response) => response.json({ ok: true }));
    testApp.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    if (betterAuthUserId !== "") {
      await database.session.deleteMany({ where: { betterAuthUserId } });
      await database.device.deleteMany({ where: { accountId } });
      await database.account.deleteMany({ where: { id: accountId } });
      await authPool.query('DELETE FROM "auth_session" WHERE "userId" = $1', [betterAuthUserId]);
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  async function generateKeyPair(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: JWK }> {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
  }

  async function dpopProof(method: string, path: string, bearerToken?: string): Promise<string> {
    return new SignJWT({
      htm: method,
      htu: `${BASE_URL}${path}`,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      ...(bearerToken === undefined
        ? {}
        : { ath: createHash("sha256").update(bearerToken, "ascii").digest("base64url") }),
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: "dpop+jwt",
        jwk: dpopKeyPair.publicJwk as unknown as Record<string, unknown>,
      })
      .sign(dpopKeyPair.privateKey);
  }

  /** L1 + L2 through the real router. Returns the bearer token and the new session row. */
  async function deviceLogin(): Promise<{ token: string; row: SessionRow; sessionExpiresAt: string }> {
    const challengeResponse = await request(testApp)
      .post("/v1/auth/devices/login/challenge")
      .set("dpop", await dpopProof("POST", "/v1/auth/devices/login/challenge"))
      .send({ device_id: deviceId });
    expect(challengeResponse.status).toBe(200);
    const challenge: string = challengeResponse.body.data.challenge;

    const jws = await new SignJWT({
      purpose: "login",
      challenge,
      device_id: deviceId,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: "ES256", typ: "vistablox-device-auth+jwt", kid: deviceBioJkt })
      .sign(devicePrivateKey);
    const verifyResponse = await request(testApp)
      .post("/v1/auth/devices/login/verify")
      .set("dpop", await dpopProof("POST", "/v1/auth/devices/login/verify"))
      .send({ device_id: deviceId, challenge, jws });
    expect(verifyResponse.status).toBe(200);

    const token = verifyResponse.headers["set-auth-token"] as string;
    const rawToken = decodeURIComponent(token).split(".")[0];
    return {
      token,
      row: await sessionRow(rawToken as string),
      sessionExpiresAt: verifyResponse.body.data.session_expires_at as string,
    };
  }

  async function sessionRow(rawToken: string): Promise<SessionRow> {
    const result = await authPool.query<SessionRow>(
      'SELECT "id", "createdAt", "updatedAt", "expiresAt" FROM "auth_session" WHERE "token" = $1',
      [rawToken],
    );
    return result.rows[0] as SessionRow;
  }

  async function sessionRowById(id: string): Promise<SessionRow | undefined> {
    const result = await authPool.query<SessionRow>(
      'SELECT "id", "createdAt", "updatedAt", "expiresAt" FROM "auth_session" WHERE "id" = $1',
      [id],
    );
    return result.rows[0];
  }

  /** Moves the session back in time, as if it had been created `createdAgoMs` ago. */
  async function ageSession(
    id: string,
    times: { createdAgoMs: number; lastActivityAgoMs: number; expiresAt?: Date },
  ): Promise<void> {
    const now = Date.now();
    const createdAt = new Date(now - times.createdAgoMs);
    await authPool.query(
      'UPDATE "auth_session" SET "createdAt" = $1, "updatedAt" = $2, "expiresAt" = $3 WHERE "id" = $4',
      [
        createdAt,
        new Date(now - times.lastActivityAgoMs),
        times.expiresAt ?? new Date(createdAt.getTime() + 30 * MINUTE),
        id,
      ],
    );
  }

  async function callProtected(token: string, withDpop = true) {
    const call = request(testApp).get(PROTECTED_PATH).set("authorization", `Bearer ${token}`);
    return withDpop ? call.set("dpop", await dpopProof("GET", PROTECTED_PATH, token)) : call;
  }

  it("creates a device session that ends exactly 30 min after creation, reports that expiry, and mirrors idle 5 / absolute 30", async () => {
    const { row, sessionExpiresAt } = await deviceLogin();

    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(30 * MINUTE);
    expect(row.updatedAt.getTime()).toBe(row.createdAt.getTime());
    expect(new Date(sessionExpiresAt).getTime()).toBe(row.expiresAt.getTime());

    const mirrored = await database.session.findFirst({ where: { betterAuthSessionId: row.id } });
    expect(mirrored?.idleExpiresAt.getTime()).toBe(row.createdAt.getTime() + 5 * MINUTE);
    expect(mirrored?.absoluteExpiresAt.getTime()).toBe(row.createdAt.getTime() + 30 * MINUTE);
  });

  it("records activity on an authenticated request but never renews the session", async () => {
    const { token, row } = await deviceLogin();
    // 10 min old, last active 1 min ago: better-auth's refresh is due.
    await ageSession(row.id, { createdAgoMs: 10 * MINUTE, lastActivityAgoMs: MINUTE });
    const before = await sessionRowById(row.id);
    const requestedAt = Date.now();

    const response = await callProtected(token);

    expect(response.status).toBe(200);
    const after = await sessionRowById(row.id);
    expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(requestedAt);

    const mirrored = await database.session.findFirst({ where: { betterAuthSessionId: row.id } });
    expect(mirrored?.lastSeenAt.getTime()).toBe(after?.updatedAt.getTime());
    expect(mirrored?.idleExpiresAt.getTime()).toBe((after?.updatedAt.getTime() ?? 0) + 5 * MINUTE);
  });

  it("answers 401 REAUTH_REQUIRED after 5 idle minutes, deletes the session, and marks the mirror row expired", async () => {
    const { token, row } = await deviceLogin();
    await ageSession(row.id, { createdAgoMs: 6 * MINUTE, lastActivityAgoMs: 5 * MINUTE + 1_000 });

    const response = await callProtected(token);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "REAUTH_REQUIRED", status: 401 });
    expect(await sessionRowById(row.id)).toBeUndefined();
    const mirrored = await database.session.findFirst({ where: { betterAuthSessionId: row.id } });
    expect(mirrored).toMatchObject({ status: "revoked", revocationReason: "expired" });
  });

  it("answers 401 REAUTH_REQUIRED once 30 min have passed since creation, however recent the activity", async () => {
    const { token, row } = await deviceLogin();
    await ageSession(row.id, { createdAgoMs: 31 * MINUTE, lastActivityAgoMs: 30_000 });

    const response = await callProtected(token);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("REAUTH_REQUIRED");
    expect(await sessionRowById(row.id)).toBeUndefined();
  });

  it("does not count a request without the session's DPoP proof as activity", async () => {
    const { token, row } = await deviceLogin();
    await ageSession(row.id, { createdAgoMs: 4 * MINUTE, lastActivityAgoMs: 4 * MINUTE });
    const before = await sessionRowById(row.id);

    const response = await callProtected(token, false);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("DPOP_PROOF_MISSING");
    const after = await sessionRowById(row.id);
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
  });
});
