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
type KeyPair = { privateKey: webcrypto.CryptoKey; publicJwk: JWK };

interface Customer {
  userId: string;
  accountId: string;
  bioJkt: string;
  bioKeys: KeyPair;
  dpopKeys: KeyPair;
  dpopJkt: string;
}

// Real L1/L2 through the /v1 router and createBetterAuth against Postgres,
// with the audit plugin and the Prisma session mirror installed: a second
// device login supersedes the first one's session, auth.sessions (the
// mirror) records it as revoked, "superseded", and another customer's
// device session is left alone. Every session here is created by a real
// L2, never by internalAdapter.createSession outside an endpoint.
describe.skipIf(databaseUrl === undefined)("device login supersedes the device's earlier session, real stack", () => {
  const suffix = randomUUID();
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const deviceChallengeRepository = new PrismaDeviceChallengeRepository(database);
  const deviceRepository = new PrismaDeviceRepository(database);
  const dpopReplayRepository = new PrismaDpopReplayRepository(database);
  const accountRepository = new PrismaAccountRepository(database);
  const auditEvents: AuthAuditEvent[] = [];
  const customers: Customer[] = [];

  let authContext: BetterAuthContext;
  let customer: Customer;
  let otherCustomer: Customer;
  let testApp: express.Express;

  async function generateKeyPair(): Promise<KeyPair> {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
  }

  async function seedCustomer(label: string): Promise<Customer> {
    const created = await authContext.internalAdapter.createUser(
      { name: "Supersede Integration", email: `device-supersede-${label}-${suffix}@example.test`, emailVerified: true },
      { method: "internal" },
    );
    const accountId = `acct_supersede_${label}_${suffix}`;
    await database.account.create({ data: { id: accountId, betterAuthUserId: created.id, status: "active" } });
    const bioKeys = await generateKeyPair();
    const dpopKeys = await generateKeyPair();
    const seeded: Customer = {
      userId: created.id,
      accountId,
      bioJkt: await calculateJwkThumbprint(bioKeys.publicJwk, "sha256"),
      bioKeys,
      dpopKeys,
      dpopJkt: await calculateJwkThumbprint(dpopKeys.publicJwk, "sha256"),
    };
    await database.device.create({
      data: {
        deviceId: `device_supersede_${label}_${suffix}`,
        accountId,
        betterAuthUserId: created.id,
        dpopJkt: seeded.dpopJkt,
        bioJkt: seeded.bioJkt,
        biometricPublicJwk: bioKeys.publicJwk as object,
        platform: "android",
        attestationMetadata: {},
      },
    });
    customers.push(seeded);
    return seeded;
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
    customer = await seedCustomer("main");
    otherCustomer = await seedCustomer("other");

    testApp = express();
    testApp.use(express.json());
    testApp.use(requestContext);
    testApp.use(
      "/v1/auth/mobile",
      createDeviceAuthRouter(
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository }),
        new IssueDeviceChallengeService(deviceChallengeRepository, deviceRepository),
        auth,
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository, recordReplays: false }),
      ),
    );
    testApp.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    for (const seeded of customers) {
      await database.session.deleteMany({ where: { accountId: seeded.accountId } });
      await database.device.deleteMany({ where: { accountId: seeded.accountId } });
      await database.deviceChallenge.deleteMany({ where: { dpopJkt: seeded.dpopJkt } });
      await database.account.deleteMany({ where: { id: seeded.accountId } });
      await authPool.query('DELETE FROM "auth_session" WHERE "userId" = $1', [seeded.userId]);
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [seeded.userId]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  async function dpopProof(who: Customer, path: string): Promise<string> {
    return new SignJWT({ htm: "POST", htu: `${BASE_URL}${path}`, iat: Math.floor(Date.now() / 1000), jti: randomUUID() })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: who.dpopKeys.publicJwk as unknown as Record<string, unknown> })
      .sign(who.dpopKeys.privateKey);
  }

  async function loginJws(who: Customer, challenge: string): Promise<string> {
    return new SignJWT({ purpose: "login", challenge, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "ES256", typ: "vistablox-device-auth+jwt", kid: who.bioJkt })
      .sign(who.bioKeys.privateKey);
  }

  async function issueChallenge(who: Customer): Promise<string> {
    const challengeResponse = await request(testApp)
      .post(CHALLENGE_PATH)
      .set("dpop", await dpopProof(who, CHALLENGE_PATH))
      .send({});
    expect(challengeResponse.status).toBe(200);
    return challengeResponse.body.data.challenge as string;
  }

  async function verify(who: Customer, challenge: string): Promise<request.Response> {
    return request(testApp)
      .post(VERIFY_PATH)
      .set("dpop", await dpopProof(who, VERIFY_PATH))
      .send({ challenge, jws: await loginJws(who, challenge) });
  }

  async function login(who: Customer): Promise<request.Response> {
    return verify(who, await issueChallenge(who));
  }

  // Sequential logins can land in the same millisecond, and the survivor is
  // the newest by (createdAt, id); a short pause keeps "later" meaning later.
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  /** Live device_biometric sessions of this customer bound to their device's DPoP key. */
  async function deviceSessionIds(who: Customer): Promise<string[]> {
    const sessions = (await authContext.internalAdapter.listSessions(who.userId)) as Array<
      Record<string, unknown> & { id: string; expiresAt: Date | string }
    >;
    return sessions
      .filter(
        (session) =>
          session.dpopJkt === who.dpopJkt &&
          session.authenticationLevel === "device_biometric" &&
          new Date(session.expiresAt).getTime() > Date.now(),
      )
      .map((session) => session.id);
  }

  it("two logins leave the device exactly one live session; the first is revoked as superseded in auth.sessions and the audit trail; another customer's session stays", async () => {
    expect((await login(otherCustomer)).status).toBe(200);
    const otherIds = await deviceSessionIds(otherCustomer);
    expect(otherIds).toHaveLength(1);

    expect((await login(customer)).status).toBe(200);
    const [firstId] = await deviceSessionIds(customer);
    expect(firstId).toBeDefined();
    await tick();
    expect((await login(customer)).status).toBe(200);

    const ids = await deviceSessionIds(customer);
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
    expect(await deviceSessionIds(otherCustomer)).toEqual(otherIds);
  });

  it("a failed login revokes nothing", async () => {
    const before = await deviceSessionIds(customer);
    expect(before).toHaveLength(1);

    // A challenge that was never issued: the login fails before any session.
    const neverIssued = `never-issued-${suffix}`;
    const response = await request(testApp)
      .post(VERIFY_PATH)
      .set("dpop", await dpopProof(customer, VERIFY_PATH))
      .send({ challenge: neverIssued, jws: await loginJws(customer, neverIssued) });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await deviceSessionIds(customer)).toEqual(before);
  });

  it("two overlapping logins from the phone leave exactly one live session, never none", async () => {
    const first = await issueChallenge(customer);
    const second = await issueChallenge(customer);

    const [a, b] = await Promise.all([verify(customer, first), verify(customer, second)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await deviceSessionIds(customer)).toHaveLength(1);
  });
});
