import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// The replay-window queries against Postgres, on the database's clock
// (domain/device-challenge-replay.ts): consumption time comes from the
// database, wasConsumedWithinReplayWindow matches only the exact challenge
// (purpose, DPoP key, device) consumed less than 120 s ago, and pruning keeps
// expired challenges for the replay window before deleting.
describe.skipIf(databaseUrl === undefined)("device challenge replay window, Postgres", () => {
  const suffix = randomUUID();
  const dpopJkt = `dpop-replay-db-${suffix}`;
  const database = createPrismaClient(databaseUrl ?? "");
  const challenges = new PrismaDeviceChallengeRepository(database);

  afterAll(async () => {
    await database.deviceChallenge.deleteMany({ where: { dpopJkt: { in: [dpopJkt, `${dpopJkt}-other`] } } });
    await database.$disconnect();
  });

  async function issueAndConsume(challenge: string, callerNow: Date = new Date()): Promise<void> {
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt,
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 300_000),
    });
    await expect(
      challenges.consume({ challenge, purpose: "enrol-device", dpopJkt, deviceId: undefined, now: callerNow }),
    ).resolves.toBe(true);
  }

  async function moveConsumptionBack(challenge: string, seconds: number): Promise<void> {
    await database.$executeRaw`
      UPDATE auth.device_challenges
      SET consumed_at = now() - (${seconds}::integer * interval '1 second')
      WHERE challenge = ${challenge}
    `;
  }

  it("reports a challenge consumed less than 120 s ago, and not once 120 s have passed, only for its own purpose and DPoP key", async () => {
    const challenge = `replay-db-consumed-${suffix}`;
    await issueAndConsume(challenge);
    const query = { challenge, purpose: "enrol-device", dpopJkt, deviceId: undefined };

    await expect(challenges.wasConsumedWithinReplayWindow(query)).resolves.toBe(true);
    await expect(challenges.wasConsumedWithinReplayWindow({ ...query, dpopJkt: `${dpopJkt}-other` })).resolves.toBe(false);
    await expect(challenges.wasConsumedWithinReplayWindow({ ...query, purpose: "login" })).resolves.toBe(false);

    await moveConsumptionBack(challenge, 119);
    await expect(challenges.wasConsumedWithinReplayWindow(query)).resolves.toBe(true);

    await moveConsumptionBack(challenge, 121);
    await expect(challenges.wasConsumedWithinReplayWindow(query)).resolves.toBe(false);
  });

  it("records consumed_at from the database's clock, not the caller's", async () => {
    const challenge = `replay-db-clock-${suffix}`;
    // The caller's clock is an hour behind; expiry still uses it.
    await issueAndConsume(challenge, new Date(Date.now() - 3_600_000));

    const rows = await database.$queryRaw<Array<{ close: boolean }>>`
      SELECT abs(extract(epoch FROM (now() - consumed_at))) < 10 AS close
      FROM auth.device_challenges
      WHERE challenge = ${challenge}
    `;
    expect(rows[0]?.close).toBe(true);
    await expect(
      challenges.wasConsumedWithinReplayWindow({ challenge, purpose: "enrol-device", dpopJkt, deviceId: undefined }),
    ).resolves.toBe(true);
  });

  it("never reports an unconsumed challenge as consumed", async () => {
    const challenge = `replay-db-unused-${suffix}`;
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt,
      deviceId: undefined,
      expiresAt: new Date(Date.now() + 300_000),
    });

    await expect(
      challenges.wasConsumedWithinReplayWindow({ challenge, purpose: "enrol-device", dpopJkt, deviceId: undefined }),
    ).resolves.toBe(false);
  });

  it("keeps an expired challenge for the replay window, then prunes it", async () => {
    const now = new Date();
    const recent = `replay-db-recent-${suffix}`;
    const old = `replay-db-old-${suffix}`;
    await challenges.issue({
      challenge: recent,
      purpose: "enrol-device",
      dpopJkt,
      deviceId: undefined,
      expiresAt: new Date(now.getTime() - 60_000),
    });
    await challenges.issue({
      challenge: old,
      purpose: "enrol-device",
      dpopJkt,
      deviceId: undefined,
      expiresAt: new Date(now.getTime() - 180_000),
    });

    await challenges.pruneExpired();

    expect(await database.deviceChallenge.findUnique({ where: { challenge: recent } })).not.toBeNull();
    expect(await database.deviceChallenge.findUnique({ where: { challenge: old } })).toBeNull();
  });
});
