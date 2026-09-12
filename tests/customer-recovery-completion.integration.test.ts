import { createHash, randomUUID, webcrypto } from "node:crypto";

import express from "express";
import { Pool } from "pg";
import request from "supertest";
import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Only the Android key-attestation chain check is stubbed: this test has no
// real Android keystore chain. Everything else in E2 runs for real.
vi.mock("../src/modules/auth/application/android-attestation-verifier.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/auth/application/android-attestation-verifier.js")>();
  return { ...actual, verifyAndroidKeyAttestation: vi.fn(async () => undefined) };
});

import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import { createDeviceAuthRouter } from "../src/modules/auth/api/device-auth.router.js";
import { createRequireDpopOnly } from "../src/modules/auth/api/require-dpop-only.js";
import {
  CompleteAccountRecoveryService,
  OpenAccountRecoveryCaseService,
} from "../src/modules/auth/application/account-recovery.service.js";
import { IssueDeviceChallengeService } from "../src/modules/auth/application/device-challenge-issuance.service.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import { LoginDeviceService } from "../src/modules/auth/application/device-login.service.js";
import { BetterAuthCustomerAccountAdministrator } from "../src/modules/auth/infrastructure/better-auth-customer-account-administrator.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaSessionMirror } from "../src/modules/auth/infrastructure/prisma-session-mirror.js";
import { PrismaAccountRecoveryRepository } from "../src/modules/auth/repository/prisma-account-recovery.repository.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";
import { PrismaDpopReplayRepository } from "../src/modules/auth/repository/prisma-dpop-replay.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const SECRET = "integration-test-secret-that-is-at-least-32-characters";
const MOBILE = "/v1/auth/mobile";

type KeyPair = { privateKey: webcrypto.CryptoKey; publicJwk: JWK };
type BetterAuthContext = Awaited<ReturnType<typeof createBetterAuth>["$context"]>;

// A staff-reviewed CUSTOMER recovery case from opening to completion,
// through the real services, better-auth and Postgres: opening restricts the
// account and ends the lost phone's session; completion revokes the device
// (it can't log in), removes its device_key login method, clears the
// recovery flag and audits every step; the same phone (same DPoP key) then
// re-enrols through a Google sign-in and E1/E2 and logs in.
describe.skipIf(databaseUrl === undefined)("customer recovery case, completion, then re-enrolment, real stack", () => {
  const suffix = randomUUID();
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const challengeRepository = new PrismaDeviceChallengeRepository(database);
  const deviceRepository = new PrismaDeviceRepository(database);
  const dpopReplayRepository = new PrismaDpopReplayRepository(database);
  const recoveryRepository = new PrismaAccountRecoveryRepository(database);
  const sendAccountRecoveryCompletedEmail = vi.fn().mockResolvedValue(undefined);
  const sendAccountRecoveryCaseOpenedEmail = vi.fn().mockResolvedValue(undefined);
  const emailSender = {
    sendAccountRecoveryCompletedEmail,
    sendAccountRecoveryCaseOpenedEmail,
  } as unknown as EmailSender;

  const customerAccountId = `acct_recovery_customer_${suffix}`;
  const actorAccountId = `acct_recovery_actor_${suffix}`;
  const reviewerOneId = `acct_recovery_reviewer_one_${suffix}`;
  const reviewerTwoId = `acct_recovery_reviewer_two_${suffix}`;
  const accountIds = [customerAccountId, actorAccountId, reviewerOneId, reviewerTwoId];
  const contactEmail = `recovery-customer-${suffix}@example.test`;
  const oldDeviceId = `device_recovery_old_${suffix}`;

  const userIds: string[] = [];
  let customerUserId = "";
  let dpopKeys: KeyPair;
  let dpopJkt = "";
  let oldBioKeys: KeyPair;
  let oldBioJkt = "";
  let authContext: BetterAuthContext;
  let auth: ReturnType<typeof createBetterAuth>;
  let testApp: express.Express;

  async function generateKeyPair(): Promise<KeyPair> {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return { privateKey: pair.privateKey, publicJwk: await exportJWK(pair.publicKey) };
  }

  async function dpopProof(path: string, bearerToken?: string): Promise<string> {
    return new SignJWT({
      htm: "POST",
      htu: `${BASE_URL}${path}`,
      iat: Math.floor(Date.now() / 1000),
      jti: randomUUID(),
      ...(bearerToken === undefined
        ? {}
        : { ath: createHash("sha256").update(bearerToken, "ascii").digest("base64url") }),
    })
      .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: dpopKeys.publicJwk as unknown as Record<string, unknown> })
      .sign(dpopKeys.privateKey);
  }

  // L1 then L2 with this phone's DPoP key, signed by the given biometric key.
  async function deviceLogin(deviceId: string, bioKeys: KeyPair, bioJkt: string) {
    const challengeResponse = await request(testApp)
      .post(`${MOBILE}/login/challenge`)
      .set("dpop", await dpopProof(`${MOBILE}/login/challenge`))
      .send({ device_id: deviceId });
    expect(challengeResponse.status).toBe(200);
    const challenge: string = challengeResponse.body.data.challenge;
    const jws = await new SignJWT({ purpose: "login", challenge, device_id: deviceId, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "ES256", typ: "vistablox-device-auth+jwt", kid: bioJkt })
      .sign(bioKeys.privateKey);
    return request(testApp)
      .post(`${MOBILE}/login/verify`)
      .set("dpop", await dpopProof(`${MOBILE}/login/verify`))
      .send({ device_id: deviceId, challenge, jws });
  }

  async function liveSessionCount(): Promise<number> {
    const result = await authPool.query('SELECT "id" FROM "auth_session" WHERE "userId" = $1', [customerUserId]);
    return result.rowCount ?? 0;
  }

  beforeAll(async () => {
    auth = createBetterAuth({
      database: authPool,
      baseURL: BASE_URL,
      secret: SECRET,
      secureCookies: false,
      trustedOrigins: [BASE_URL],
      sessionMirror: new PrismaSessionMirror(database, SECRET),
      dpop: { baseUrl: BASE_URL, replayRepository: dpopReplayRepository },
      deviceAuth: {
        accounts: new PrismaAccountRepository(database),
        enrolDevice: new EnrolDeviceService(challengeRepository, deviceRepository, {
          policy: "disabled",
          pinnedRootCertificates: [],
          certDigestAllowlist: [],
          revocationList: { isRevoked: async () => false },
          playIntegrityDecoder: undefined,
        }),
        loginDevice: new LoginDeviceService(challengeRepository, deviceRepository),
      },
    });
    authContext = await auth.$context;

    for (const accountId of accountIds) {
      const user = await authContext.internalAdapter.createUser(
        {
          name: "Recovery Completion",
          email: accountId === customerAccountId ? contactEmail : `${accountId}@example.test`,
          emailVerified: true,
        },
        { method: "internal" },
      );
      userIds.push(user.id);
      if (accountId === customerAccountId) customerUserId = user.id;
      await database.account.create({
        data: {
          id: accountId,
          betterAuthUserId: user.id,
          status: "active",
          ...(accountId === customerAccountId ? { protectedContactEmail: contactEmail } : {}),
        },
      });
    }

    dpopKeys = await generateKeyPair();
    dpopJkt = await calculateJwkThumbprint(dpopKeys.publicJwk, "sha256");
    oldBioKeys = await generateKeyPair();
    oldBioJkt = await calculateJwkThumbprint(oldBioKeys.publicJwk, "sha256");
    // The phone as it was before it was lost: an enrolled device and its
    // device_key login method.
    await database.device.create({
      data: {
        deviceId: oldDeviceId,
        accountId: customerAccountId,
        betterAuthUserId: customerUserId,
        dpopJkt,
        bioJkt: oldBioJkt,
        biometricPublicJwk: oldBioKeys.publicJwk as object,
        platform: "android",
        attestationMetadata: {},
      },
    });
    await database.loginMethod.create({
      data: {
        id: `login_recovery_old_${suffix}`,
        accountId: customerAccountId,
        methodType: "device_key",
        providerSubject: oldDeviceId,
      },
    });

    testApp = express();
    testApp.use(express.json());
    testApp.use(requestContext);
    testApp.use(
      MOBILE,
      createDeviceAuthRouter(
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository }),
        new IssueDeviceChallengeService(challengeRepository, deviceRepository),
        auth,
        createRequireDpopOnly({ baseUrl: BASE_URL, replayRepository: dpopReplayRepository, recordReplays: false }),
      ),
    );
    testApp.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    await database.auditLog.deleteMany({ where: { actorAccountId: { in: accountIds } } });
    await database.accountRecoveryCase.deleteMany({ where: { accountId: customerAccountId } });
    await database.loginMethod.deleteMany({ where: { accountId: customerAccountId } });
    await database.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await database.device.deleteMany({ where: { accountId: customerAccountId } });
    await database.deviceChallenge.deleteMany({ where: { dpopJkt } });
    await database.account.deleteMany({ where: { id: { in: accountIds } } });
    for (const id of userIds) {
      await authPool.query('DELETE FROM "auth_session" WHERE "userId" = $1', [id]);
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [id]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("opens and completes the case, revoking the lost phone and auditing every step; the same phone then re-enrols via Google + E1/E2 and logs in, and the old device can't", async () => {
    const administrator = new BetterAuthCustomerAccountAdministrator(auth, emailSender);

    // The lost phone has a live device session.
    const beforeLogin = await deviceLogin(oldDeviceId, oldBioKeys, oldBioJkt);
    expect(beforeLogin.status).toBe(200);
    expect(await liveSessionCount()).toBe(1);

    // Staff open the case through the real service: the recovery flag is
    // set on the customer (this CHECK used to refuse it for customers), the
    // account is restricted, and every session ends.
    const opened = await new OpenAccountRecoveryCaseService(recoveryRepository, administrator, emailSender).execute({
      accountId: customerAccountId,
      actorAccountId,
      traceId: `trace_${suffix}`,
    });
    expect(opened.status).toBe("open");
    const flagWhileOpen = await authPool.query('SELECT "recoveryRequiredAt" FROM "auth_user" WHERE "id" = $1', [customerUserId]);
    expect(flagWhileOpen.rows[0]?.recoveryRequiredAt).not.toBeNull();
    expect((await database.account.findUniqueOrThrow({ where: { id: customerAccountId } })).status).toBe("recovery_review");
    expect(await liveSessionCount()).toBe(0);

    // Didit session, primary review, second-reviewer approval.
    const reviewedAt = new Date();
    await recoveryRepository.recordDiditSession({
      caseId: opened.id,
      diditReference: `didit_${suffix}`,
      actorAccountId,
      traceId: `trace_${suffix}`,
      recordedAt: reviewedAt,
    });
    await recoveryRepository.recordPrimaryReview({
      caseId: opened.id,
      reviewerAccountId: reviewerOneId,
      corroborationCategory: "last_login",
      traceId: `trace_${suffix}`,
      reviewedAt,
    });
    const approved = await recoveryRepository.decideCase({
      caseId: opened.id,
      reviewerAccountId: reviewerTwoId,
      decision: "approved",
      reason: "Didit and corroboration checked out.",
      traceId: `trace_${suffix}`,
      decidedAt: reviewedAt,
    });
    expect(approved?.status).toBe("approved");

    const completed = await new CompleteAccountRecoveryService(
      recoveryRepository,
      administrator,
      emailSender,
      "https://app.example.test/recover-account",
    ).execute({ caseId: opened.id, actorAccountId, traceId: `trace_${suffix}` });
    expect(completed.status).toBe("completed");

    // The old device is revoked, with when and why, and its device_key row is gone.
    const oldDevice = await database.device.findUniqueOrThrow({ where: { deviceId: oldDeviceId } });
    expect(oldDevice.status).toBe("revoked");
    expect(oldDevice.revokedAt).not.toBeNull();
    expect(oldDevice.revocationReason).toBe("account_recovery");
    expect(
      await database.loginMethod.count({ where: { accountId: customerAccountId, methodType: "device_key" } }),
    ).toBe(0);

    // No session survives, and the session mirror shows none as active.
    expect(await liveSessionCount()).toBe(0);
    expect(await database.session.count({ where: { accountId: customerAccountId, status: "active" } })).toBe(0);

    // The recovery flag is cleared and the account is active again.
    const flag = await authPool.query('SELECT "recoveryRequiredAt" FROM "auth_user" WHERE "id" = $1', [customerUserId]);
    expect(flag.rows[0]?.recoveryRequiredAt).toBeNull();
    expect((await database.account.findUniqueOrThrow({ where: { id: customerAccountId } })).status).toBe("active");

    // Every completion step is audited.
    const audited = await database.auditLog.findMany({
      where: { actorAccountId, resourceId: { in: [opened.id, oldDeviceId, customerAccountId] } },
      select: { action: true, resourceId: true, changes: true },
    });
    expect(audited.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "authentication.device_revoked",
        "authentication.login_method_removed",
        "authentication.account_recovery_sessions_revoked",
        "authentication.account_recovery_restriction_cleared",
        "authentication.account_recovery_completed",
        "authentication.account_recovery_reenrolment_notice",
      ]),
    );
    expect(audited.find((row) => row.action === "authentication.device_revoked")?.resourceId).toBe(oldDeviceId);
    // Opening the case already ended the device session, so completion's
    // own sweep finds none left here.
    expect(audited.find((row) => row.action === "authentication.account_recovery_sessions_revoked")?.changes).toMatchObject({
      revoked_device_count: 1,
      revoked_session_count: 0,
    });

    // The customer is told, with no link, to sign in with Google/Apple and set the phone up again.
    expect(sendAccountRecoveryCompletedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: contactEmail, deviceReenrolmentRequired: true }),
    );

    // The old device can't log in.
    const oldAfterRecovery = await deviceLogin(oldDeviceId, oldBioKeys, oldBioJkt);
    expect(oldAfterRecovery.status).toBe(401);
    expect(oldAfterRecovery.body.code).toBe("DEVICE_LOGIN_FAILED");
    expect(oldAfterRecovery.headers["set-auth-token"]).toBeUndefined();

    // The same phone signs in with Google again and re-enrols: E1, then E2
    // with a new biometric key. A real Google sign-in can't run here, and
    // sessions can only be created through an authentication endpoint, so
    // its result is written directly: the pending oauth_pending session that
    // /sign-in/social creates, bound to the phone's same DPoP key.
    const pending = { token: `pending${randomUUID().replace(/-/g, "")}` };
    await authPool.query(
      `INSERT INTO "auth_session" ("id", "token", "userId", "expiresAt", "updatedAt", "authenticationLevel", "dpopJkt")
       VALUES ($1, $2, $3, now() + interval '10 minutes', now(), 'oauth_pending', $4)`,
      [`session_pending_${suffix}`, pending.token, customerUserId, dpopJkt],
    );
    const enrolChallengeResponse = await request(testApp)
      .post(`${MOBILE}/enrol/challenge`)
      .set("dpop", await dpopProof(`${MOBILE}/enrol/challenge`));
    expect(enrolChallengeResponse.status).toBe(200);
    const enrolChallenge: string = enrolChallengeResponse.body.data.challenge;
    const newBioKeys = await generateKeyPair();
    const newBioJkt = await calculateJwkThumbprint(newBioKeys.publicJwk, "sha256");
    const enrolJws = await new SignJWT({
      purpose: "enrol-device",
      challenge: enrolChallenge,
      dpop_jkt: dpopJkt,
      iat: Math.floor(Date.now() / 1000),
    })
      .setProtectedHeader({
        alg: "ES256",
        typ: "vistablox-device-auth+jwt",
        kid: newBioJkt,
        jwk: newBioKeys.publicJwk as unknown as Record<string, unknown>,
      })
      .sign(newBioKeys.privateKey);
    const enrolResponse = await request(testApp)
      .post(`${MOBILE}/enrol/verify`)
      .set("authorization", `Bearer ${pending.token}`)
      .set("dpop", await dpopProof(`${MOBILE}/enrol/verify`, pending.token))
      .send({
        challenge: enrolChallenge,
        jws: enrolJws,
        attestation: { platform: "android", key_attestation_chain: ["leaf"] },
      });
    expect(enrolResponse.status).toBe(200);
    expect(enrolResponse.body.data.status).toBe("active");
    const newDeviceId: string = enrolResponse.body.data.device_id;
    expect(newDeviceId).not.toBe(oldDeviceId);

    // A new active device for the same DPoP key, recorded as the account's device_key.
    const newDevice = await database.device.findUniqueOrThrow({ where: { deviceId: newDeviceId } });
    expect(newDevice).toMatchObject({ status: "active", dpopJkt, bioJkt: newBioJkt });
    const deviceKeyRows = await database.loginMethod.findMany({
      where: { accountId: customerAccountId, methodType: "device_key" },
    });
    expect(deviceKeyRows.map((row) => row.providerSubject)).toEqual([newDeviceId]);

    // The re-enrolled phone logs in.
    const newLogin = await deviceLogin(newDeviceId, newBioKeys, newBioJkt);
    expect(newLogin.status).toBe(200);
    expect(newLogin.headers["set-auth-token"]).toBeDefined();

    // The old device still can't, even with the same DPoP key.
    const oldAfterReenrol = await deviceLogin(oldDeviceId, oldBioKeys, oldBioJkt);
    expect(oldAfterReenrol.status).toBe(401);
    expect(oldAfterReenrol.body.code).toBe("DEVICE_LOGIN_FAILED");
  }, 60_000);
});
