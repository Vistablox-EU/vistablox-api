import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaDeviceChallengeRepository } from "../src/modules/auth/repository/prisma-device-challenge.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// The replay-window queries against Postgres: wasConsumedSince matches only
// the exact challenge (purpose, DPoP key, device) and consumption time, and
// pruning keeps expired challenges for the replay window before deleting.
describe.skipIf(databaseUrl === undefined)("device challenge replay window, Postgres", () => {
  const suffix = randomUUID();
  const dpopJkt = `dpop-replay-db-${suffix}`;
  const database = createPrismaClient(databaseUrl ?? "");
  const challenges = new PrismaDeviceChallengeRepository(database);

  afterAll(async () => {
    await database.deviceChallenge.deleteMany({ where: { dpopJkt: { in: [dpopJkt, `${dpopJkt}-other`] } } });
    await database.$disconnect();
  });

  it("reports a consumed challenge as consumed since a time before its use, not since a later one, and only for its own DPoP key", async () => {
    const challenge = `replay-db-consumed-${suffix}`;
    const now = new Date();
    await challenges.issue({
      challenge,
      purpose: "enrol-device",
      dpopJkt,
      deviceId: undefined,
      expiresAt: new Date(now.getTime() + 300_000),
    });
    await expect(
      challenges.consume({ challenge, purpose: "enrol-device", dpopJkt, deviceId: undefined, now }),
    ).resolves.toBe(true);

    const query = { challenge, purpose: "enrol-device", dpopJkt, deviceId: undefined };
    await expect(challenges.wasConsumedSince({ ...query, since: new Date(now.getTime() - 1_000) })).resolves.toBe(true);
    await expect(challenges.wasConsumedSince({ ...query, since: new Date(now.getTime() + 1_000) })).resolves.toBe(false);
    await expect(
      challenges.wasConsumedSince({ ...query, dpopJkt: `${dpopJkt}-other`, since: new Date(now.getTime() - 1_000) }),
    ).resolves.toBe(false);
    await expect(
      challenges.wasConsumedSince({ ...query, purpose: "login", since: new Date(now.getTime() - 1_000) }),
    ).resolves.toBe(false);
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
      challenges.wasConsumedSince({ challenge, purpose: "enrol-device", dpopJkt, deviceId: undefined, since: new Date(0) }),
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

    await challenges.pruneExpired(now);

    expect(await database.deviceChallenge.findUnique({ where: { challenge: recent } })).not.toBeNull();
    expect(await database.deviceChallenge.findUnique({ where: { challenge: old } })).toBeNull();
  });
});
