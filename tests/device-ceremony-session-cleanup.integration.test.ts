import { randomUUID, webcrypto } from "node:crypto";

import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import { createDeviceAuthRouter } from "../src/modules/auth/api/device-auth.router.js";
import { createRequireDpopOnly } from "../src/modules/auth/api/require-dpop-only.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import { IssueDeviceChallengeService } from "../src/modules/auth/application/device-challenge-issuance.service.js";
import { LoginDeviceService } from "../src/modules/auth/application/device-login.service.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";
import { PrismaDpopReplayRepository } from "../src/modules/auth/repository/prisma-dpop-replay.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";

// A device login (L2) that fails after its session row was created, through
// the real /v1 router and the real createBetterAuth against Postgres: the
// failure is injected into better-auth's own user lookup, and the test
// checks that no device_biometric session is left in auth_session.
describe.skipIf(databaseUrl === undefined)("L2 failure after session creation leaves no live session, real stack", () => {
  const suffix = randomUUID();
  const email = `device-cleanup-${suffix}@example.test`;
  const accountId = `acct_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const deviceChallengeRepository = new PrismaDeviceChallengeRepository(database);
  const deviceRepository = new PrismaDeviceRepository(database);
  const dpopReplayRepository = new PrismaDpopReplayRepository(database);
  const accountRepository = new PrismaAccountRepository(database);

  let betterAuthUserId = "";
  let deviceId = "";
  let deviceBioJkt = "";
  let devicePrivateKey: webcrypto.CryptoKey;
  let dpopKeyPair: { privateKey: webcrypto.CryptoKey; publicJwk: JWK };
  let auth: ReturnType<typeof createBetterAuth>;
  let testApp: express.Express;

  async function generateKeyPair(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: JWK }> {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
  }

  beforeAll(async () => {
    auth = createBetterAuth({
      database: authPool,
      baseURL: BASE_URL,
      secret: "integration-test-secret-that-is-at-least-32-characters",
      secureCookies: false,
      trustedOrigins: [BASE_URL],
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
      { name: "Cleanup Integration", email, emailVerified: true },
      { method: "internal" },
    );
    betterAuthUserId = createdUser.id;
    await database.account.create({ data: { id: accountId, betterAuthUserId, status: "active" } });

    const deviceKeys = await generateKeyPair();
    devicePrivateKey = deviceKeys.privateKey;
    deviceBioJkt = await calculateJwkThumbprint(deviceKeys.publicJwk, "sha256");
    dpopKeyPair = await generateKeyPair();
    const seeded = await deviceRepository.create({
      accountId,
      betterAuthUserId,
      dpopJkt: await calculateJwkThumbprint(dpopKeyPair.publicJwk, "sha256"),
      bioJkt: deviceBioJkt,
      biometricPublicJwk: deviceKeys.publicJwk as unknown as Record<string, unknown>,
      platform: "android",
      model: undefined,
      osVersion: undefined,
      appVersion: undefined,
      attestationMetadata: {},
    });
    deviceId = seeded.deviceId;

    testApp = express();
    testApp.use(express.json());
    testApp.use(requestContext);
    testApp.use(
      "/v1/auth/mobile",
      createDeviceAuthRouter(
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository }),
        new IssueDeviceChallengeService(deviceChallengeRepository),
        auth,
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository, recordReplays: false }),
      ),
    );
    testApp.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    if (betterAuthUserId !== "") {
      await database.device.deleteMany({ where: { accountId } });
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

  it("deletes the device session when the user lookup fails after it was created", async () => {
    const challengeResponse = await request(testApp)
      .post("/v1/auth/mobile/login/challenge")
      .set("dpop", await dpopProof("/v1/auth/mobile/login/challenge"))
      .send({ device_id: deviceId });
    expect(challengeResponse.status).toBe(200);
    const challenge: string = challengeResponse.body.data.challenge;
    const jws = await new SignJWT({ purpose: "login", challenge, device_id: deviceId, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "ES256", typ: "vistablox-device-auth+jwt", kid: deviceBioJkt })
      .sign(devicePrivateKey);
    const authContext = await auth.$context;
    // Null for the whole request, not just once: in the real factory the
    // session.create.before hooks (staff-account guard, authentication-level
    // resolver) look the user up before the plugin's own lookup does, and
    // both accept a null user for a customer device session.
    const lookup = vi.spyOn(authContext.internalAdapter, "findUserById").mockResolvedValue(null);

    const response = await request(testApp)
      .post("/v1/auth/mobile/login/verify")
      .set("dpop", await dpopProof("/v1/auth/mobile/login/verify"))
      .send({ device_id: deviceId, challenge, jws });
    lookup.mockRestore();

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("device.account_mapping_missing");
    expect(response.headers["set-auth-token"]).toBeUndefined();
    const live = await authPool.query(
      'SELECT "id" FROM "auth_session" WHERE "userId" = $1 AND "authenticationLevel" = $2',
      [betterAuthUserId, "device_biometric"],
    );
    expect(live.rowCount).toBe(0);
  });
});
