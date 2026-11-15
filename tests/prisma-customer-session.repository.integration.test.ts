import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { ListOwnSessionsService } from "../src/modules/auth/application/customer/customer-session.service.js";
import { PrismaCustomerSessionRepository } from "../src/modules/auth/repository/customer/prisma-customer-session.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const MINUTE = 60_000;

// GET /v1/auth/sessions against Postgres: the mirror rows in auth.sessions
// plus better-auth's own auth_session rows, through the real repository and
// the real listing service.
describe.skipIf(databaseUrl === undefined)("customer session listing, PostgreSQL", () => {
  const suffix = randomUUID();
  const accountId = `acct_${suffix}`;
  const betterAuthUserId = `auth_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaCustomerSessionRepository(database);
  const now = new Date();

  const ago = (minutes: number): Date => new Date(now.getTime() - minutes * MINUTE);
  const ahead = (minutes: number): Date => new Date(now.getTime() + minutes * MINUTE);

  async function insertProviderSession(input: {
    key: string;
    level: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
  }): Promise<string> {
    const id = `ba_${input.key}_${suffix}`;
    await authPool.query(
      'INSERT INTO "auth_session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId", "authenticationLevel") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, input.expiresAt, `tok_${input.key}_${suffix}`, input.createdAt, input.updatedAt, betterAuthUserId, input.level],
    );
    return id;
  }

  // The mirror row's own expiry columns are deliberately left far in the past
  // on every row: they are display data that only device sessions keep
  // current, and the listing must not read them.
  async function insertMirrorRow(input: {
    key: string;
    status?: string;
    providerSessionId: string | null;
    createdAt: Date;
  }): Promise<string> {
    const id = `sess_${input.key}_${suffix}`;
    await database.session.create({
      data: {
        id,
        accountId,
        channel: "mobile",
        status: input.status ?? "active",
        betterAuthUserId,
        betterAuthSessionId: input.providerSessionId,
        authMethodAtLogin: "device_biometric",
        createdAt: input.createdAt,
        lastSeenAt: input.createdAt,
        idleExpiresAt: new Date("2026-01-01T00:00:00.000Z"),
        absoluteExpiresAt: new Date("2026-01-01T00:30:00.000Z"),
        ...(input.status === "revoked" ? { revokedAt: now, revocationReason: "self_revoke_one" } : {}),
      },
    });
    return id;
  }

  beforeAll(async () => {
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Session Listing User", `${betterAuthUserId}@example.test`, true, "customer"],
    );
    await database.account.create({
      data: { id: accountId, betterAuthUserId, protectedContactEmail: `${betterAuthUserId}@example.test` },
    });

    // A live device session: 2 min old, last used 1 min ago.
    const live = await insertProviderSession({
      key: "live",
      level: "device_biometric",
      createdAt: ago(2),
      updatedAt: ago(1),
      expiresAt: ahead(28),
    });
    await insertMirrorRow({ key: "live", providerSessionId: live, createdAt: ago(2) });

    // The staging symptom: a device session long past both limits, still 'active' in the mirror.
    const expired = await insertProviderSession({
      key: "expired",
      level: "device_biometric",
      createdAt: ago(120),
      updatedAt: ago(119),
      expiresAt: ago(90),
    });
    await insertMirrorRow({ key: "expired", providerSessionId: expired, createdAt: ago(120) });

    // Idle for 6 minutes: better-auth's expiresAt is still ahead, the device limit is not.
    const idle = await insertProviderSession({
      key: "idle",
      level: "device_biometric",
      createdAt: ago(10),
      updatedAt: ago(6),
      expiresAt: ahead(20),
    });
    await insertMirrorRow({ key: "idle", providerSessionId: idle, createdAt: ago(10) });

    // A non-device session whose mirror expiry columns are long past (they are never refreshed),
    // but which better-auth still honours: it must stay listed.
    const pending = await insertProviderSession({
      key: "pending",
      level: "oauth_pending",
      createdAt: ago(300),
      updatedAt: ago(1),
      expiresAt: ahead(29),
    });
    await insertMirrorRow({ key: "pending", providerSessionId: pending, createdAt: ago(300) });

    // Better-auth deleted the row without the mirror hearing about it (for example an account cascade).
    await insertMirrorRow({ key: "orphan", providerSessionId: `ba_missing_${suffix}`, createdAt: ago(50) });

    // Revoked: reported as stored, whatever better-auth holds.
    await insertMirrorRow({ key: "revoked", status: "revoked", providerSessionId: null, createdAt: ago(40) });
  });

  afterAll(async () => {
    await database.session.deleteMany({ where: { accountId } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("hands the listing service each row's better-auth facts", async () => {
    const rows = await repository.listForAccount(accountId);
    const byId = new Map(rows.map((row) => [row.sessionId, row]));

    expect(byId.get(`sess_live_${suffix}`)?.providerSession).toMatchObject({
      authenticationLevel: "device_biometric",
    });
    expect(byId.get(`sess_pending_${suffix}`)?.providerSession?.authenticationLevel).toBe("oauth_pending");
    expect(byId.get(`sess_orphan_${suffix}`)?.providerSession).toBeNull();
    expect(byId.get(`sess_revoked_${suffix}`)?.providerSession).toBeNull();
  });

  it("lists only sessions that can still authenticate, plus revoked history", async () => {
    const service = new ListOwnSessionsService(repository, () => now);

    const sessions = await service.execute(accountId, `ba_live_${suffix}`);

    expect(sessions.map((s) => [s.sessionId.replace(`_${suffix}`, ""), s.status, s.isCurrent]).sort()).toEqual([
      ["sess_live", "active", true],
      ["sess_pending", "active", false],
      ["sess_revoked", "revoked", false],
    ]);
  });
});
