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

    const listed = await grants.listForAccount(accountId);

    expect(listed.map((grant) => grant.grantId)).toEqual([ownGrantId]);
    expect(await grants.isOwnedByAccount(accountId, ownGrantId)).toBe(true);
    expect(await grants.isOwnedByAccount(accountId, otherGrantId)).toBe(false);
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
