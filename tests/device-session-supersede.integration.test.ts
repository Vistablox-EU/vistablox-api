import { randomUUID, webcrypto } from "node:crypto";

import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import { createDeviceAuthRouter } from "../src/modules/auth/api/device-auth.router.js";
import { createRequireDpopOnly } from "../src/modules/auth/api/require-dpop-only.js";
import type { AuthAuditEvent } from "../src/modules/auth/application/auth-audit-sink.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import { IssueDeviceChallengeService } from "../src/modules/auth/application/device-challenge-issuance.service.js";
import { LoginDeviceService } from "../src/modules/auth/application/device-login.service.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaSessionMirror } from "../src/modules/auth/infrastructure/prisma-session-mirror.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";
import { PrismaDpopReplayRepository } from "../src/modules/auth/repository/prisma-dpop-replay.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const SECRET = "integration-test-secret-that-is-at-least-32-characters";
const CHALLENGE_PATH = "/v1/auth/mobile/login/challenge";
const VERIFY_PATH = "/v1/auth/mobile/login/verify";

type BetterAuthContext = Awaited<ReturnType<typeof createBetterAuth>["$context"]>;

// Real L1/L2 through the /v1 router and createBetterAuth against Postgres,
// with the audit plugin and the Prisma session mirror installed: a second
// device login supersedes the first one's session, and auth.sessions (the
// mirror) records it as revoked, "superseded".
describe.skipIf(databaseUrl === undefined)("device login supersedes the device's earlier session, real stack", () => {
  const suffix = randomUUID();
  const email = `device-supersede-${suffix}@example.test`;
  const accountId = `acct_supersede_${suffix}`;
  const deviceId = `device_supersede_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const deviceChallengeRepository = new PrismaDeviceChallengeRepository(database);
  const deviceRepository = new PrismaDeviceRepository(database);
  const dpopReplayRepository = new PrismaDpopReplayRepository(database);
  const accountRepository = new PrismaAccountRepository(database);
  const auditEvents: AuthAuditEvent[] = [];

  let authContext: BetterAuthContext;
  let betterAuthUserId = "";
  let deviceBioJkt = "";
  let devicePrivateKey: webcrypto.CryptoKey;
  let dpopKeyPair: { privateKey: webcrypto.CryptoKey; publicJwk: JWK };
  let dpopJkt = "";
  let webSessionToken = "";
  let testApp: express.Express;

  async function generateKeyPair(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: JWK }> {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
  }

  beforeAll(async () => {
    const auth = createBetterAuth({
      database: authPool,
      baseURL: BASE_URL,
      secret: SECRET,
      secureCookies: false,
      trustedOrigins: [BASE_URL],
      authAuditSink: { record: async (event: AuthAuditEvent) => void auditEvents.push(event) },
      sessionMirror: new PrismaSessionMirror(database, SECRET),
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
    authContext = await auth.$context;
    const createdUser = await authContext.internalAdapter.createUser(
      { name: "Supersede Integration", email, emailVerified: true },
      { method: "internal" },
    );
    betterAuthUserId = createdUser.id;
    await database.account.create({ data: { id: accountId, betterAuthUserId, status: "active" } });
    // The same customer's web session (no DPoP key): a device login must
    // leave it alone.
    webSessionToken = (await authContext.internalAdapter.createSession(betterAuthUserId)).token;

    const deviceKeys = await generateKeyPair();
    devicePrivateKey = deviceKeys.privateKey;
    deviceBioJkt = await calculateJwkThumbprint(deviceKeys.publicJwk, "sha256");
    dpopKeyPair = await generateKeyPair();
    dpopJkt = await calculateJwkThumbprint(dpopKeyPair.publicJwk, "sha256");
    await database.device.create({
      data: {
        deviceId,
        accountId,
        betterAuthUserId,
        dpopJkt,
        bioJkt: deviceBioJkt,
        biometricPublicJwk: deviceKeys.publicJwk as object,
        platform: "android",
        attestationMetadata: {},
      },
    });

    testApp = express();
    testApp.use(express.json());
    testApp.use(requestContext);
    testApp.use(
      "/v1/auth/mobile",
      createDeviceAuthRouter(
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository }),
        new IssueDeviceChallengeService(deviceChallengeRepository, () => new Date(), deviceRepository),
        auth,
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository, recordReplays: false }),
      ),
    );
    testApp.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    if (betterAuthUserId !== "") {
      await database.session.deleteMany({ where: { accountId } });
      await database.device.deleteMany({ where: { accountId } });
      await database.deviceChallenge.deleteMany({ where: { dpopJkt } });
      await database.account.deleteMany({ where: { id: accountId } });
      await authPool.query('DELETE FROM "auth_session" WHERE "userId" = $1', [betterAuthUserId]);
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  async function dpopProof(path: string): Promise<string> {
    return new SignJWT({ htm: "POST", htu: `${BASE_URL}${path}`, iat: Math.floor(Date.now() / 1000), jti: randomUUID() })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: dpopKeyPair.publicJwk as unknown as Record<string, unknown> })
      .sign(dpopKeyPair.privateKey);
  }

  async function loginJws(challenge: string): Promise<string> {
    return new SignJWT({ purpose: "login", challenge, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "ES256", typ: "vistablox-device-auth+jwt", kid: deviceBioJkt })
      .sign(devicePrivateKey);
  }

  async function login(): Promise<request.Response> {
    const challengeResponse = await request(testApp).post(CHALLENGE_PATH).set("dpop", await dpopProof(CHALLENGE_PATH)).send({});
    expect(challengeResponse.status).toBe(200);
    const challenge: string = challengeResponse.body.data.challenge;
    return request(testApp)
      .post(VERIFY_PATH)
      .set("dpop", await dpopProof(VERIFY_PATH))
      .send({ challenge, jws: await loginJws(challenge) });
  }

  /** Live device_biometric sessions of this customer bound to the device's DPoP key. */
  async function deviceSessionIds(): Promise<string[]> {
    const sessions = (await authContext.internalAdapter.listSessions(betterAuthUserId)) as Array<
      Record<string, unknown> & { id: string; expiresAt: Date | string }
    >;
    return sessions
      .filter(
        (session) =>
          session.dpopJkt === dpopJkt &&
          session.authenticationLevel === "device_biometric" &&
          new Date(session.expiresAt).getTime() > Date.now(),
      )
      .map((session) => session.id);
  }

  it("two logins leave the device exactly one live session; the first is revoked as superseded in auth.sessions and the audit trail; the web session stays", async () => {
    expect((await login()).status).toBe(200);
    const [firstId] = await deviceSessionIds();
    expect(firstId).toBeDefined();

    expect((await login()).status).toBe(200);

    const ids = await deviceSessionIds();
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(firstId);
    const mirrored = await database.session.findFirst({ where: { betterAuthSessionId: firstId as string } });
    expect(mirrored).toMatchObject({ status: "revoked", revocationReason: "superseded" });
    expect(
      auditEvents.some(
        (event) =>
          event.action === "authentication.session_revoked" &&
          event.resourceId === firstId &&
          event.changes.reason === "superseded",
      ),
    ).toBe(true);
    const all = await authContext.internalAdapter.listSessions(betterAuthUserId);
    expect(all.some((session) => session.token === webSessionToken)).toBe(true);
  });

  it("a failed login revokes nothing", async () => {
    const before = await deviceSessionIds();
    expect(before).toHaveLength(1);

    // A challenge that was never issued: the login fails before any session.
    const response = await request(testApp)
      .post(VERIFY_PATH)
      .set("dpop", await dpopProof(VERIFY_PATH))
      .send({ challenge: `never-issued-${suffix}`, jws: await loginJws(`never-issued-${suffix}`) });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await deviceSessionIds()).toEqual(before);
  });
});
