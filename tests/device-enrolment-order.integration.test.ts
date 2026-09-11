import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import {
  DeviceAlreadyEnrolledError,
  DeviceChallengeExpiredError,
} from "../src/modules/auth/application/device-auth-errors.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const ENROL = "enrol-device";

// The E2 order the mobile app relies on, against the real Prisma
// repositories and Postgres: 409 DEVICE_ALREADY_ENROLLED is decided before
// the challenge is consumed (the challenge row stays unconsumed), and a 400
// for a used challenge leaves no device row behind.
describe.skipIf(databaseUrl === undefined)("E2 order against Postgres: active device before challenge", () => {
  const suffix = randomUUID();
  const accountWithDevice = `acct_order_dev_${suffix}`;
  const accountWithoutDevice = `acct_order_none_${suffix}`;
  const dpopWithDevice = `dpop-order-dev-${suffix}`;
  const dpopWithoutDevice = `dpop-order-none-${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const challenges = new PrismaDeviceChallengeRepository(database);
  const devices = new PrismaDeviceRepository(database);
  const service = new EnrolDeviceService(challenges, devices, {
    policy: "disabled",
    pinnedRootCertificates: [],
    certDigestAllowlist: [],
    revocationList: { isRevoked: async () => false },
    playIntegrityDecoder: undefined,
  });
  const betterAuthUserIds: string[] = [];

  beforeAll(async () => {
    const auth = createBetterAuth({
      database: authPool,
      baseURL: BASE_URL,
      secret: "integration-test-secret-that-is-at-least-32-characters",
      secureCookies: false,
      trustedOrigins: [BASE_URL],
    });
    const authContext = await auth.$context;
    for (const accountId of [accountWithDevice, accountWithoutDevice]) {
      const user = await authContext.internalAdapter.createUser(
        { name: "Enrol Order Test", email: `${accountId}@example.test`, emailVerified: true },
        { method: "internal" },
      );
      betterAuthUserIds.push(user.id);
      await database.account.create({ data: { id: accountId, betterAuthUserId: user.id, status: "active" } });
    }
    await devices.create({
      accountId: accountWithDevice,
      betterAuthUserId: betterAuthUserIds[0] as string,
      dpopJkt: `existing-device-jkt-${suffix}`,
      bioJkt: `existing-device-bio-${suffix}`,
      biometricPublicJwk: {},
      platform: "android",
      model: undefined,
      osVersion: undefined,
      appVersion: undefined,
      attestationMetadata: {},
    });
  }, 30_000);

  afterAll(async () => {
    await database.deviceChallenge.deleteMany({
      where: { dpopJkt: { in: [dpopWithDevice, dpopWithoutDevice] } },
    });
    await database.device.deleteMany({ where: { accountId: { in: [accountWithDevice, accountWithoutDevice] } } });
    await database.account.deleteMany({ where: { id: { in: [accountWithDevice, accountWithoutDevice] } } });
    for (const id of betterAuthUserIds) {
      await authPool.query('DELETE FROM "auth_session" WHERE "userId" = $1', [id]);
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [id]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  function enrolInput(accountId: string, userIndex: number, challenge: string, dpopJkt: string) {
    return {
      accountId,
      betterAuthUserId: betterAuthUserIds[userIndex] as string,
      dpopJkt,
      challenge,
      jws: "not-reached",
      attestation: {
        platform: "android",
        keyAttestationChain: [],
        integrityToken: undefined,
        model: undefined,
        osVersion: undefined,
        appVersion: undefined,
      },
    };
  }

  async function issue(challenge: string, dpopJkt: string): Promise<void> {
    await challenges.issue({
      challenge,
      purpose: ENROL,
      dpopJkt,
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
  }

  it("answers 409 for an account with an active device and leaves the challenge unconsumed", async () => {
    const challenge = `order-db-409-${suffix}`;
    await issue(challenge, dpopWithDevice);

    await expect(
      service.execute(enrolInput(accountWithDevice, 0, challenge, dpopWithDevice)),
    ).rejects.toBeInstanceOf(DeviceAlreadyEnrolledError);

    const row = await database.deviceChallenge.findUnique({ where: { challenge } });
    expect(row?.consumedAt).toBeNull();
    await expect(
      challenges.consume({ challenge, purpose: ENROL, dpopJkt: dpopWithDevice, deviceId: undefined, now: new Date() }),
    ).resolves.toBe(true);
  });

  it("answers 400 for an already-consumed challenge when the account has no device, and creates no device", async () => {
    const challenge = `order-db-400-${suffix}`;
    await issue(challenge, dpopWithoutDevice);
    await challenges.consume({
      challenge,
      purpose: ENROL,
      dpopJkt: dpopWithoutDevice,
      deviceId: undefined,
      now: new Date(),
    });

    await expect(
      service.execute(enrolInput(accountWithoutDevice, 1, challenge, dpopWithoutDevice)),
    ).rejects.toBeInstanceOf(DeviceChallengeExpiredError);

    expect(await database.device.count({ where: { accountId: accountWithoutDevice } })).toBe(0);
  });
});
