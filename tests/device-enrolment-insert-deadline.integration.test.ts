import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import {
  DeviceChallengeExpiredError,
  DeviceChallengeReplayedError,
} from "../src/modules/auth/application/device-auth-errors.js";
import { EnrolDeviceService } from "../src/modules/auth/application/device-enrolment.service.js";
import { createBetterAuth } from "../src/modules/auth/infrastructure/better-auth.factory.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const BASE_URL = "http://localhost:3000";
const ENROL = "enrol-device";

const scenarios = ["fresh", "stalled", "unconsumed", "locked", "replay", "idle", "pruned"] as const;
type Scenario = (typeof scenarios)[number];

// The E2 insert deadline and replay window on the database's clock
// (domain/device-challenge-replay.ts), against Postgres. A stalled enrolment
// is simulated by moving its challenge's consumed_at back, or by making its
// device insert wait on another transaction's lock.
describe.skipIf(databaseUrl === undefined)("E2 insert deadline and replay window on the database clock, Postgres", () => {
  const suffix = randomUUID();
  const accountId = (scenario: Scenario) => `acct_deadline_${scenario}_${suffix}`;
  const dpopJkt = (scenario: Scenario) => `dpop-deadline-${scenario}-${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const challenges = new PrismaDeviceChallengeRepository(database);
  const devices = new PrismaDeviceRepository(database);
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
        { name: "Insert Deadline Test", email: `${accountId(scenario)}@example.test`, emailVerified: true },
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
    await database.account.deleteMany({ where: { id: { in: accountIds } } });
    for (const id of userIds.values()) {
      await authPool.query('DELETE FROM "auth_session" WHERE "userId" = $1', [id]);
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [id]);
    }
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  async function issue(scenario: Scenario, challenge: string): Promise<void> {
    await challenges.issue({
      challenge,
      purpose: ENROL,
      dpopJkt: dpopJkt(scenario),
      deviceId: undefined,
      ttlSeconds: 300,
    });
  }

  async function issueAndConsume(scenario: Scenario, challenge: string): Promise<void> {
    await issue(scenario, challenge);
    await expect(
      challenges.consume({ challenge, purpose: ENROL, dpopJkt: dpopJkt(scenario), deviceId: undefined }),
    ).resolves.toBe(true);
  }

  async function moveConsumptionBack(challenge: string, seconds: number): Promise<void> {
    await database.$executeRaw`
      UPDATE auth.device_challenges
      SET consumed_at = now() - (${seconds}::integer * interval '1 second')
      WHERE challenge = ${challenge}
    `;
  }

  function createInput(scenario: Scenario, challenge: string) {
    return {
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
    };
  }

  async function deviceCount(scenario: Scenario): Promise<number> {
    return database.device.count({ where: { accountId: accountId(scenario) } });
  }

  it("registers a device for a challenge consumed moments ago", async () => {
    const challenge = `deadline-fresh-${suffix}`;
    await issueAndConsume("fresh", challenge);

    await expect(devices.create(createInput("fresh", challenge))).resolves.toMatchObject({
      accountId: accountId("fresh"),
    });
    expect(await deviceCount("fresh")).toBe(1);
  });

  it("registers nothing when the insert comes 60 s after the challenge was consumed (a stalled enrolment)", async () => {
    const challenge = `deadline-stalled-${suffix}`;
    await issueAndConsume("stalled", challenge);
    await moveConsumptionBack(challenge, 60);

    await expect(devices.create(createInput("stalled", challenge))).rejects.toBeInstanceOf(
      DeviceChallengeExpiredError,
    );
    expect(await deviceCount("stalled")).toBe(0);
  });

  it("registers nothing for a challenge that was never consumed", async () => {
    const challenge = `deadline-unconsumed-${suffix}`;
    await issue("unconsumed", challenge);

    await expect(devices.create(createInput("unconsumed", challenge))).rejects.toBeInstanceOf(
      DeviceChallengeExpiredError,
    );
    expect(await deviceCount("unconsumed")).toBe(0);
  });

  it("gives up at its lock timeout instead of waiting on a lock, and registers nothing", async () => {
    const challenge = `deadline-locked-${suffix}`;
    await issueAndConsume("locked", challenge);
    // Another transaction holds an uncommitted row with the same DPoP key,
    // so this insert has to wait for it (only this test's key is affected).
    const locker = await authPool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query(
        `INSERT INTO auth.devices
           (device_id, account_id, better_auth_user_id, dpop_jkt, bio_jkt, biometric_public_jwk, platform, attestation_metadata)
         VALUES ($1, $2, $3, $4, 'bio-locker', '{}', 'android', '{}')`,
        [`device_locker_${suffix}`, accountId("locked"), userIds.get("locked"), dpopJkt("locked")],
      );

      const started = Date.now();
      await expect(devices.create(createInput("locked", challenge))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect(await deviceCount("locked")).toBe(0);
  }, 30_000);

  it("registers nothing when the API stalls between the deadline check and the insert past the idle-in-transaction timeout", async () => {
    const challenge = `deadline-idle-${suffix}`;
    await issueAndConsume("idle", challenge);
    // The API stalls 6 s after the check, inside the transaction. Postgres
    // ends a transaction left idle for 5 s (idle_in_transaction_session_timeout),
    // well before Prisma's own 10 s transaction timeout, so the insert that
    // follows fails and nothing is registered.
    // Its own client, so the connection error Postgres raises when it ends
    // the idle transaction can be captured.
    const connectionErrors: Array<Error & { code?: string }> = [];
    const stallingDatabase = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: databaseUrl ?? "" },
        { onConnectionError: (error) => void connectionErrors.push(error) },
      ),
    });
    const stalling = new PrismaDeviceRepository(stallingDatabase, {
      afterDeadlineCheck: () => new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
    });

    try {
      const started = Date.now();
      const failure = await stalling.create(createInput("idle", challenge)).then(
        () => null,
        (error: unknown) => error,
      );
      const elapsed = Date.now() - started;

      expect(failure).not.toBeNull();
      // The cause is the 5 s idle-transaction timeout: Postgres reported
      // 25P03 (idle_in_transaction_session_timeout), and the failure came
      // after 5 s but well before Prisma's own 10 s transaction timeout.
      const idleTimeoutReported =
        connectionErrors.some((error) => error.code === "25P03") ||
        /idle-in-transaction/i.test(String((failure as Error | null)?.message ?? ""));
      expect(idleTimeoutReported).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(9_000);
      expect(await deviceCount("idle")).toBe(0);
    } finally {
      await stallingDatabase.$disconnect();
    }
  }, 30_000);

  it("a prune started between the deadline check and the insert waits for the insert to commit", async () => {
    const challenge = `deadline-pruned-${suffix}`;
    await issueAndConsume("pruned", challenge);
    // Expired long enough ago that pruning targets it, though it was
    // consumed moments ago.
    await database.$executeRaw`
      UPDATE auth.device_challenges SET expires_at = now() - interval '10 minutes' WHERE challenge = ${challenge}
    `;
    let prune: Promise<number> | undefined;
    let pruneSettled = false;
    const repository = new PrismaDeviceRepository(database, {
      afterDeadlineCheck: async () => {
        prune = challenges.pruneExpired().finally(() => {
          pruneSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        // Still waiting on the challenge row this transaction holds FOR SHARE.
        expect(pruneSettled).toBe(false);
      },
    });

    await expect(repository.create(createInput("pruned", challenge))).resolves.toMatchObject({
      accountId: accountId("pruned"),
    });
    await prune;
    expect(await deviceCount("pruned")).toBe(1);
    expect(await database.deviceChallenge.findUnique({ where: { challenge } })).toBeNull();
  }, 30_000);

  it("answers a replay REPLAYED inside the window and EXPIRED after it, on the database clock, whatever the API clock says", async () => {
    const challenge = `deadline-replay-${suffix}`;
    await issueAndConsume("replay", challenge);
    // This API instance's clock runs an hour ahead: it plays no part.
    const service = new EnrolDeviceService(
      challenges,
      devices,
      {
        policy: "disabled",
        pinnedRootCertificates: [],
        certDigestAllowlist: [],
        revocationList: { isRevoked: async () => false },
        playIntegrityDecoder: undefined,
      },
      () => new Date(Date.now() + 3_600_000),
    );
    const replay = {
      accountId: accountId("replay"),
      betterAuthUserId: userIds.get("replay") as string,
      dpopJkt: dpopJkt("replay"),
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

    await expect(service.execute(replay)).rejects.toBeInstanceOf(DeviceChallengeReplayedError);

    await moveConsumptionBack(challenge, 121);
    await expect(service.execute(replay)).rejects.toBeInstanceOf(DeviceChallengeExpiredError);
    expect(await deviceCount("replay")).toBe(0);
  });
});
