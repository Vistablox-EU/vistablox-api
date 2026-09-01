import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PostgresOidcAdapter } from "../src/modules/auth/infrastructure/postgres-oidc-adapter.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("oidc-provider PostgreSQL adapter integration", () => {
  const suffix = randomUUID();
  const pool = new Pool({ connectionString: databaseUrl });
  const accessTokens = new PostgresOidcAdapter(pool, "AccessToken");
  const sessions = new PostgresOidcAdapter(pool, "Session");
  const deviceCodes = new PostgresOidcAdapter(pool, "DeviceCode");

  afterEach(async () => {
    await pool.query('DELETE FROM "oidc_model_instances" WHERE "id" LIKE $1', [`${suffix}%`]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("round-trips a payload and enforces the model's expiry", async () => {
    const id = `${suffix}_at_01`;
    await accessTokens.upsert(id, { accountId: "auth_01", grantId: "grant_01" }, 60);

    expect(await accessTokens.find(id)).toEqual({ accountId: "auth_01", grantId: "grant_01" });

    await pool.query(
      `UPDATE "oidc_model_instances" SET "expires_at" = now() - interval '1 second'
       WHERE "model_name" = 'AccessToken' AND "id" = $1`,
      [id],
    );
    expect(await accessTokens.find(id)).toBeUndefined();
  });

  it("finds a Session by its uid and never expires a null-expiry row", async () => {
    const id = `${suffix}_sess_01`;
    const uid = `${suffix}_uid_01`;
    await sessions.upsert(id, { accountId: "auth_01", uid });

    expect(await sessions.findByUid(uid)).toEqual({ accountId: "auth_01", uid });
    expect(await sessions.findByUid(`${suffix}_missing`)).toBeUndefined();
  });

  it("finds a DeviceCode by its user code", async () => {
    const id = `${suffix}_dc_01`;
    const userCode = `${suffix}_code`;
    await deviceCodes.upsert(id, { accountId: "auth_01", userCode }, 600);

    expect(await deviceCodes.findByUserCode(userCode)).toEqual({
      accountId: "auth_01",
      userCode,
    });
  });

  it("marks a payload consumed without deleting it", async () => {
    const id = `${suffix}_ac_01`;
    const authorizationCodes = new PostgresOidcAdapter(pool, "AuthorizationCode");
    await authorizationCodes.upsert(id, { accountId: "auth_01" }, 60);

    await authorizationCodes.consume(id);

    const found = await authorizationCodes.find(id);
    expect(found?.accountId).toBe("auth_01");
    expect(typeof found?.consumed).toBe("number");
  });

  it("destroys a single row by id", async () => {
    const id = `${suffix}_rt_01`;
    const refreshTokens = new PostgresOidcAdapter(pool, "RefreshToken");
    await refreshTokens.upsert(id, { accountId: "auth_01" }, 60);

    await refreshTokens.destroy(id);

    expect(await refreshTokens.find(id)).toBeUndefined();
  });

  it("revokeByGrantId deletes every model row sharing the grant, regardless of model type", async () => {
    const grantId = `${suffix}_grant_revoke`;
    const refreshTokens = new PostgresOidcAdapter(pool, "RefreshToken");
    const accessTokenId = `${suffix}_at_revoke`;
    const refreshTokenId = `${suffix}_rt_revoke`;
    await accessTokens.upsert(accessTokenId, { accountId: "auth_01", grantId }, 600);
    await refreshTokens.upsert(refreshTokenId, { accountId: "auth_01", grantId }, 600);

    await accessTokens.revokeByGrantId(grantId);

    expect(await accessTokens.find(accessTokenId)).toBeUndefined();
    expect(await refreshTokens.find(refreshTokenId)).toBeUndefined();
  });

  it("rejects two rows of the same model claiming the same uid", async () => {
    const uid = `${suffix}_uid_conflict`;
    await sessions.upsert(`${suffix}_sess_a`, { accountId: "auth_01", uid });

    await expect(sessions.upsert(`${suffix}_sess_b`, { accountId: "auth_02", uid })).rejects.toThrow();
  });
});
