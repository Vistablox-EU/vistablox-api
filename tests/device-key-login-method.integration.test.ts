import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const ENROL = "enrol-device";

const scenarios = ["enrolled", "rolled_back", "other_device"] as const;
type Scenario = (typeof scenarios)[number];

// E2 registers the device and records it as the account's device_key login
// method in one transaction; the rollback after a failed E2
// (EnrolDeviceService.rollback) removes both. Against Postgres, after the
// migration that allows device_key.
describe.skipIf(databaseUrl === undefined)("device_key login method around E2 and its rollback, Postgres", () => {
  const suffix = randomUUID();
  const accountId = (scenario: Scenario) => `acct_devkey_${scenario}_${suffix}`;
  const dpopJkt = (scenario: Scenario) => `dpop-devkey-${scenario}-${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const challenges = new PrismaDeviceChallengeRepository(database);
  const devices = new PrismaDeviceRepository(database);
  const enrolment = new EnrolDeviceService(challenges, devices, {
    policy: "disabled",
    pinnedRootCertificates: [],
    certDigestAllowlist: [],
    revocationList: { isRevoked: async () => false },
    playIntegrityDecoder: undefined,
  });
  const userIds = new Map<Scenario, string>();

  beforeAll(async () => {
    const auth = createBetterAuth({
      database: authPool,
      baseURL: BASE_URL,
      secret: "integration-test-secret-that-is-at-least-32-characters",
      secureCookies: false,
      trustedOrigins: [BASE_URL],
    });
    const authContext = await auth.$context;
    for (const scenario of scenarios) {
      const user = await authContext.internalAdapter.createUser(
        { name: "Device Key Login Method", email: `${accountId(scenario)}@example.test`, emailVerified: true },
        { method: "internal" },
      );
      userIds.set(scenario, user.id);
      await database.account.create({ data: { id: accountId(scenario), betterAuthUserId: user.id, status: "active" } });
    }
  }, 30_000);

  afterAll(async () => {
    const accountIds = scenarios.map(accountId);
    await database.deviceChallenge.deleteMany({ where: { dpopJkt: { in: scenarios.map(dpopJkt) } } });
    await database.device.deleteMany({ where: { accountId: { in: accountIds } } });
    await database.loginMethod.deleteMany({ where: { accountId: { in: accountIds } } });
    await database.account.deleteMany({ where: { id: { in: accountIds } } });
    for (const id of userIds.values()) {
      await authPool.query('DELETE FROM "auth_session" WHERE "userId" = $1', [id]);
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [id]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  // A device registered the way E2 does it: a freshly consumed enrolment
  // challenge, then devices.create (the step after attestation).
  async function enrol(scenario: Scenario): Promise<string> {
    const challenge = `devkey-${scenario}-${suffix}`;
    await challenges.issue({ challenge, purpose: ENROL, dpopJkt: dpopJkt(scenario), deviceId: undefined, ttlSeconds: 300 });
    await expect(
      challenges.consume({ challenge, purpose: ENROL, dpopJkt: dpopJkt(scenario), deviceId: undefined }),
    ).resolves.toBe(true);
    const device = await devices.create({
      accountId: accountId(scenario),
      betterAuthUserId: userIds.get(scenario) as string,
      dpopJkt: dpopJkt(scenario),
      bioJkt: `bio-${dpopJkt(scenario)}`,
      biometricPublicJwk: {},
      platform: "android",
      model: undefined,
      osVersion: undefined,
      appVersion: undefined,
      attestationMetadata: {},
      consumedChallenge: { challenge, purpose: ENROL, dpopJkt: dpopJkt(scenario) },
    });
    return device.deviceId;
  }

  function deviceKeyRows(scenario: Scenario) {
    return database.loginMethod.findMany({
      where: { accountId: accountId(scenario), methodType: "device_key" },
    });
  }

  it("allows device_key in the login-method CHECK constraint", async () => {
    const result = await database.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'login_methods_supported_method_check'
    `;
    expect(result).toHaveLength(1);
    expect(result[0]?.definition).toContain("'device_key'");
  });

  it("records the enrolled device as the account's device_key login method", async () => {
    const deviceId = await enrol("enrolled");

    const rows = await deviceKeyRows("enrolled");
    expect(rows).toHaveLength(1);
    const device = await database.device.findUniqueOrThrow({ where: { deviceId } });
    expect(rows[0]).toMatchObject({
      providerSubject: deviceId,
      linkedViaFreshAuth: true,
      linkedAt: device.createdAt,
    });
    expect(rows[0]?.id).toMatch(/^login_/);
  });

  it("removes the device_key login method when a failed E2 rolls the device back", async () => {
    const deviceId = await enrol("rolled_back");
    expect(await deviceKeyRows("rolled_back")).toHaveLength(1);

    await enrolment.rollback(deviceId);

    expect(await database.device.findUnique({ where: { deviceId } })).toBeNull();
    expect(await deviceKeyRows("rolled_back")).toHaveLength(0);
  });

  it("rolling back a device leaves a device_key row that points at another device alone", async () => {
    const deviceId = await enrol("other_device");

    await enrolment.rollback(`device_not_this_one_${suffix}`);

    expect(await database.device.findUnique({ where: { deviceId } })).not.toBeNull();
    const rows = await deviceKeyRows("other_device");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerSubject).toBe(deviceId);
  });
});
