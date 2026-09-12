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

// The real /v1/auth/mobile/login/verify router mounted on a real Express
// app, backed by a real createBetterAuth instance and a real Postgres
// database -- no stubbed auth.api. This is the exact gap that let #58's
// asResponse bug (every E2/L2 call returning a 500, confirmed live on
// staging) slip past device-auth-router.test.ts's mocked auth.api, which
// never exercises better-auth's real dispatch shape (a raw fetch Response,
// not { response, headers }, whenever a real Request is passed without
// asResponse: false -- see device-auth.router.ts's own comment on that).
describe.skipIf(databaseUrl === undefined)("real /v1/auth/mobile/login/verify, no stubbed auth.api", () => {
  const suffix = randomUUID();
  const email = `device-auth-login-verify-${suffix}@example.test`;
  const accountId = `acct_${suffix}`;
  // The device seeded in beforeAll.
  let deviceId = "";
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const deviceChallengeRepository = new PrismaDeviceChallengeRepository(database);
  const deviceRepository = new PrismaDeviceRepository(database);
  const dpopReplayRepository = new PrismaDpopReplayRepository(database);
  const accountRepository = new PrismaAccountRepository(database);

  let betterAuthUserId = "";
  let deviceBioJkt = "";
  let devicePrivateKey: webcrypto.CryptoKey;
  // The seeded device's own DPoP key: LoginDeviceService only accepts L2
  // from the DPoP key the device is bound to (device.dpopJkt).
  let deviceDpopKeyPair: { privateKey: webcrypto.CryptoKey; publicJwk: JWK };
  let testApp: express.Express;

  beforeAll(async () => {
    const auth = createBetterAuth({
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
      { name: "Login Verify Test", email, emailVerified: true },
      { method: "internal" },
    );
    betterAuthUserId = createdUser.id;
    await database.account.create({ data: { id: accountId, betterAuthUserId, status: "active" } });

    const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    devicePrivateKey = keyPair.privateKey;
    const publicJwk = await exportJWK(keyPair.publicKey);
    deviceBioJkt = await calculateJwkThumbprint(publicJwk, "sha256");
    deviceDpopKeyPair = await generateDpopKeyPair();
    // Seeded directly: deviceRepository.create registers a device only for
    // a freshly consumed enrolment challenge.
    const seededDevice = await database.device.create({
      data: {
        deviceId: `device_login_verify_${suffix}`,
        accountId,
        betterAuthUserId,
        dpopJkt: await calculateJwkThumbprint(deviceDpopKeyPair.publicJwk, "sha256"),
        bioJkt: deviceBioJkt,
        biometricPublicJwk: publicJwk as object,
        platform: "android",
        attestationMetadata: {},
      },
    });
    deviceId = seededDevice.deviceId;

    testApp = express();
    testApp.use(express.json());
    testApp.use(requestContext);
    const requireDpopOnly = createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository });
    const requireDpopOnlyForVerify = createRequireDpopOnly({
      baseUrl: BASE_URL,
      replayRepository: dpopReplayRepository,
      recordReplays: false,
    });
    testApp.use(
      "/v1/auth/mobile",
      createDeviceAuthRouter(
        requireDpopOnly,
        new IssueDeviceChallengeService(deviceChallengeRepository, () => new Date(), deviceRepository),
        auth,
        requireDpopOnlyForVerify,
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

  async function buildLoginJws(options: { challenge: string; deviceId: string }): Promise<string> {
    return new SignJWT({
      purpose: "login",
      challenge: options.challenge,
      device_id: options.deviceId,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({ alg: "ES256", typ: "vistablox-device-auth+jwt", kid: deviceBioJkt })
      .sign(devicePrivateKey);
  }

  async function generateDpopKeyPair(): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: JWK }> {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
  }

  async function buildDpopProof(
    dpopKeyPair: { privateKey: webcrypto.CryptoKey; publicJwk: JWK },
    path: string,
  ): Promise<string> {
    return new SignJWT({
      htm: "POST",
      htu: `${BASE_URL}${path}`,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: "dpop+jwt",
        jwk: dpopKeyPair.publicJwk as unknown as Record<string, unknown>,
      })
      .sign(dpopKeyPair.privateKey);
  }

  it("returns a non-500 4xx (DEVICE_LOGIN_FAILED) for an unknown device, not the asResponse crash", async () => {
    const dpopKeyPair = await generateDpopKeyPair();
    const dpopProof = await buildDpopProof(dpopKeyPair, "/v1/auth/mobile/login/verify");
    const jws = await buildLoginJws({ challenge: "irrelevant-challenge", deviceId: "device_does_not_exist" });

    const response = await request(testApp)
      .post("/v1/auth/mobile/login/verify")
      .set("dpop", dpopProof)
      .send({ device_id: "device_does_not_exist", challenge: "irrelevant-challenge", jws });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(response.body.code).toBe("DEVICE_LOGIN_FAILED");
  });

  it("succeeds for a real seeded device with a real challenge and a real device-auth JWS: 200, device_id/session fields, set-auth-token header", async () => {
    const dpopKeyPair = deviceDpopKeyPair;

    const challengeResponse = await request(testApp)
      .post("/v1/auth/mobile/login/challenge")
      .set("dpop", await buildDpopProof(dpopKeyPair, "/v1/auth/mobile/login/challenge"))
      .send({ device_id: deviceId });
    expect(challengeResponse.status).toBe(200);
    const challenge: string = challengeResponse.body.data.challenge;

    const jws = await buildLoginJws({ challenge, deviceId });
    const verifyResponse = await request(testApp)
      .post("/v1/auth/mobile/login/verify")
      .set("dpop", await buildDpopProof(dpopKeyPair, "/v1/auth/mobile/login/verify"))
      .send({ device_id: deviceId, challenge, jws });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.data).toMatchObject({
      device_id: deviceId,
      authentication_level: "device_biometric",
    });
    expect(typeof verifyResponse.body.data.session_expires_at).toBe("string");
    expect(verifyResponse.headers["set-auth-token"]).toBeDefined();
  });

  it("logs in with no device_id anywhere: the device comes from the DPoP key, and L2 returns its device_id", async () => {
    const dpopKeyPair = deviceDpopKeyPair;

    const challengeResponse = await request(testApp)
      .post("/v1/auth/mobile/login/challenge")
      .set("dpop", await buildDpopProof(dpopKeyPair, "/v1/auth/mobile/login/challenge"))
      .send({});
    expect(challengeResponse.status).toBe(200);
    const challenge: string = challengeResponse.body.data.challenge;

    const jws = await new SignJWT({ purpose: "login", challenge, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "ES256", typ: "vistablox-device-auth+jwt", kid: deviceBioJkt })
      .sign(devicePrivateKey);
    const verifyResponse = await request(testApp)
      .post("/v1/auth/mobile/login/verify")
      .set("dpop", await buildDpopProof(dpopKeyPair, "/v1/auth/mobile/login/verify"))
      .send({ challenge, jws });

    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.data).toMatchObject({
      device_id: deviceId,
      authentication_level: "device_biometric",
    });
    expect(verifyResponse.headers["set-auth-token"]).toBeDefined();
  });

  it("rejects the identical DPoP proof presented twice with a non-500 DPOP_REPLAY, not the asResponse crash", async () => {
    const dpopKeyPair = await generateDpopKeyPair();
    const proof = await buildDpopProof(dpopKeyPair, "/v1/auth/mobile/login/challenge");

    const challengeResponse = await request(testApp)
      .post("/v1/auth/mobile/login/challenge")
      .set("dpop", proof)
      .send({ device_id: deviceId });
    expect(challengeResponse.status).toBe(200);

    // Same exact proof, reused for a second, unrelated request -- must be
    // rejected as a replay, not accepted a second time.
    const replayedResponse = await request(testApp)
      .post("/v1/auth/mobile/login/challenge")
      .set("dpop", proof)
      .send({ device_id: deviceId });

    expect(replayedResponse.status).toBeGreaterThanOrEqual(400);
    expect(replayedResponse.status).toBeLessThan(500);
    expect(replayedResponse.body.code).toBe("DPOP_REPLAY");
  });
});
