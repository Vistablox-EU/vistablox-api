import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PostgresOidcAdapter } from "../src/modules/auth/infrastructure/postgres-oidc-adapter.js";
import { PostgresOidcGrantRepository } from "../src/modules/auth/infrastructure/postgres-oidc-grant.repository.js";
import { PostgresOidcCleanupRepository } from "../src/modules/auth/infrastructure/postgres-oidc-cleanup.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("OIDC grant + cleanup PostgreSQL integration", () => {
  const suffix = randomUUID();
  const accountId = `acct_${suffix}`;
  const betterAuthUserId = `auth_${suffix}`;
  const otherAccountId = `acct_other_${suffix}`;
  const otherBetterAuthUserId = `auth_other_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const grants = new PostgresOidcGrantRepository(authPool);
  const cleanup = new PostgresOidcCleanupRepository(authPool);
  const grantModel = new PostgresOidcAdapter(authPool, "Grant");

  beforeAll(async () => {
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)',
      [
        betterAuthUserId,
        "OIDC Grant Test User",
        `oidc-grant-${suffix}@example.test`,
        true,
        "customer",
        otherBetterAuthUserId,
        "OIDC Grant Other User",
        `oidc-grant-other-${suffix}@example.test`,
        true,
        "customer",
      ],
    );
    await database.account.createMany({
      data: [
        { id: accountId, betterAuthUserId },
        { id: otherAccountId, betterAuthUserId: otherBetterAuthUserId },
      ],
    });
  });

  afterAll(async () => {
    await authPool.query('DELETE FROM "oidc_model_instances" WHERE "id" LIKE $1', [`${suffix}%`]);
    await database.account.deleteMany({ where: { id: { in: [accountId, otherAccountId] } } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1)', [
      [betterAuthUserId, otherBetterAuthUserId],
    ]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("lists only the caller's own active grants and confirms ownership", async () => {
    const ownGrantId = `${suffix}_grant_own`;
    const otherGrantId = `${suffix}_grant_other`;
    await grantModel.upsert(ownGrantId, { accountId: betterAuthUserId, clientId: "vistablox-native" });
    await grantModel.upsert(otherGrantId, {
      accountId: otherBetterAuthUserId,
      clientId: "vistablox-native",
    });

    try {
      const listed = await grants.listForAccount(accountId);

      expect(listed.map((grant) => grant.grantId)).toEqual([ownGrantId]);
      expect(await grants.isOwnedByAccount(accountId, ownGrantId)).toBe(true);
      expect(await grants.isOwnedByAccount(accountId, otherGrantId)).toBe(false);
    } finally {
      // Unlike the revoke tests below, this test never calls revoke()
      // itself, so nothing removes these rows as a side effect -- without
      // this, ownGrantId leaks into the revokeAllForAccount test later in
      // this same describe block (they share one account for the whole
      // file), which would then correctly, but unexpectedly, revoke it too.
      await authPool.query('DELETE FROM "oidc_model_instances" WHERE "id" = ANY($1)', [
        [ownGrantId, otherGrantId],
      ]);
    }
  });

  it("revoke deletes the grant row and every token row sharing its grant id", async () => {
    const grantId = `${suffix}_grant_revoke`;
    const accessTokenId = `${suffix}_at_for_revoke`;
    const accessTokens = new PostgresOidcAdapter(authPool, "AccessToken");
    await grantModel.upsert(grantId, { accountId: betterAuthUserId, clientId: "vistablox-native" });
    await accessTokens.upsert(accessTokenId, { accountId: betterAuthUserId, grantId }, 600);

    await grants.revoke(grantId);

    expect(await grants.isOwnedByAccount(accountId, grantId)).toBe(false);
    expect(await accessTokens.find(accessTokenId)).toBeUndefined();
  });

  it("revokeAllForAccount deletes every grant and token for that account, leaving other accounts untouched", async () => {
    const ownGrantA = `${suffix}_grant_all_a`;
    const ownGrantB = `${suffix}_grant_all_b`;
    const otherGrant = `${suffix}_grant_all_other`;
    const ownTokenA = `${suffix}_at_all_a`;
    const ownTokenB = `${suffix}_rt_all_b`;
    const otherToken = `${suffix}_at_all_other`;
    const accessTokens = new PostgresOidcAdapter(authPool, "AccessToken");
    const refreshTokens = new PostgresOidcAdapter(authPool, "RefreshToken");
    await grantModel.upsert(ownGrantA, { accountId: betterAuthUserId, clientId: "vistablox-native" });
    await grantModel.upsert(ownGrantB, { accountId: betterAuthUserId, clientId: "vistablox-native" });
    await grantModel.upsert(otherGrant, {
      accountId: otherBetterAuthUserId,
      clientId: "vistablox-native",
    });
    await accessTokens.upsert(ownTokenA, { accountId: betterAuthUserId, grantId: ownGrantA }, 600);
    await refreshTokens.upsert(ownTokenB, { accountId: betterAuthUserId, grantId: ownGrantB }, 600);
    await accessTokens.upsert(
      otherToken,
      { accountId: otherBetterAuthUserId, grantId: otherGrant },
      600,
    );

    const revokedGrantIds = await grants.revokeAllForAccount(accountId);

    expect(revokedGrantIds.sort()).toEqual([ownGrantA, ownGrantB].sort());
    expect(await grants.isOwnedByAccount(accountId, ownGrantA)).toBe(false);
    expect(await grants.isOwnedByAccount(accountId, ownGrantB)).toBe(false);
    expect(await accessTokens.find(ownTokenA)).toBeUndefined();
    expect(await refreshTokens.find(ownTokenB)).toBeUndefined();
    expect(await grants.isOwnedByAccount(otherAccountId, otherGrant)).toBe(true);
    expect(await accessTokens.find(otherToken)).toEqual({
      accountId: otherBetterAuthUserId,
      grantId: otherGrant,
    });
  });

  it("deleteExpired removes only rows past their expiry", async () => {
    const expiredId = `${suffix}_expired`;
    const liveId = `${suffix}_live`;
    const accessTokens = new PostgresOidcAdapter(authPool, "AccessToken");
    await accessTokens.upsert(expiredId, { accountId: betterAuthUserId }, 60);
    await accessTokens.upsert(liveId, { accountId: betterAuthUserId }, 600);
    await authPool.query(
      `UPDATE "oidc_model_instances" SET "expires_at" = now() - interval '1 second' WHERE "id" = $1`,
      [expiredId],
    );

    const deleted = await cleanup.deleteExpired();

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await accessTokens.find(expiredId)).toBeUndefined();
    expect(await accessTokens.find(liveId)).toEqual({ accountId: betterAuthUserId });
  });
});
