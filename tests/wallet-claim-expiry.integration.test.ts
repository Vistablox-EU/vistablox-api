import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import {
  WalletAddressConflictError,
  WalletRegistrationChangedError,
} from "../src/modules/wallet/repository/wallet.repository.js";

// Pending wallet claims expire (#177). The sweep is global, so vitest.config.ts
// runs this file on its own, after the parallel files. As a second guard the
// stale claims here are from 1980 and the sweep's cutoff is 1980-01-02, so it
// cannot reach a realistic fixture another suite left behind.
const databaseUrl = process.env.TEST_DATABASE_URL;
const EXPIRED_ONLY_PENDING_CHECK = "wallet_registrations_expired_only_pending_check";

describe.skipIf(databaseUrl === undefined)("wallet claim expiry PostgreSQL integration", () => {
  const suffix = randomUUID();
  const hex = suffix.replaceAll("-", "");
  const accountIds = Array.from({ length: 4 }, (_, index) => `acct_expiry${index}_${suffix}`);
  const betterAuthUserIds = accountIds.map((_, index) => `auth_expiry${index}_${suffix}`);
  const [accountA, accountB, accountC, staffAccount] = accountIds as [string, string, string, string];

  let counter = 0;
  const nextAddress = (): string => `0x${hex}${(counter++).toString(16).padStart(8, "0")}`;
  const nextCommitment = (): string => `0x${hex}${(counter++).toString(16).padStart(32, "0")}`;
  const nextEvidence = () => ({
    transactionHash: nextCommitment(),
    blockHash: nextCommitment(),
    blockNumber: 12n,
    logIndex: 0,
  });

  const longAgo = new Date("1980-01-01T00:00:00.000Z");
  const cutoff = new Date("1980-01-02T00:00:00.000Z");
  const now = new Date("2026-11-16T12:00:00.000Z");

  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const walletRepository = new PrismaWalletRepository(database);
  const settlementRepository = new PrismaSettlementRepository(database);

  const register = (accountId: string, walletAddress: string, freshAuthentication = false) =>
    walletRepository.registerWallet({
      accountId,
      walletAddress,
      registrationCommitment: nextCommitment(),
      requestedAt: new Date(),
      freshAuthentication,
    });

  const createClaim = (accountId: string, data: { requestedAt?: Date; registeredAt?: Date; expiredAt?: Date } = {}) =>
    database.walletRegistration.create({
      data: { accountId, walletAddress: nextAddress(), registrationCommitment: nextCommitment(), ...data },
    });

  const auditRows = (resourceId: string, action: string) =>
    database.auditLog.findMany({
      where: { resourceId, action: `settlement.wallet_registration_${action}` },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    for (const [index, accountId] of accountIds.entries()) {
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserIds[index], `Expiry Test ${index}`, `expiry-${index}-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId: betterAuthUserIds[index]! } });
    }
  });

  afterEach(async () => {
    await database.walletRegistration.deleteMany({ where: { accountId: { in: accountIds } } });
    await database.auditLog.deleteMany({ where: { resourceId: { in: accountIds } } });
  });

  afterAll(async () => {
    await database.walletRegistration.deleteMany({ where: { accountId: { in: accountIds } } });
    await database.auditLog.deleteMany({
      where: { OR: [{ resourceId: { in: accountIds } }, { actorAccountId: { in: accountIds } }] },
    });
    await database.account.deleteMany({ where: { id: { in: accountIds } } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1)', [betterAuthUserIds]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  describe("the sweep", () => {
    it("expires a stale pending claim with an audit row, and leaves fresh and confirmed claims alone", async () => {
      const stale = await createClaim(accountA, { requestedAt: longAgo });
      const confirmed = await createClaim(accountB, { requestedAt: longAgo, registeredAt: longAgo });
      const fresh = await createClaim(accountC, { requestedAt: new Date("1980-01-03T00:00:00.000Z") });
      expect(await settlementRepository.countPendingWalletRegistrationsBefore(cutoff)).toBeGreaterThanOrEqual(1);

      const result = await walletRepository.expirePendingWalletRegistrations({ cutoff, now });

      expect(result.expired).toBeGreaterThanOrEqual(1);
      expect(result.checked).toBeGreaterThanOrEqual(result.expired);
      const rows = await database.walletRegistration.findMany({
        where: { accountId: { in: [accountA, accountB, accountC] } },
        select: { accountId: true, expiredAt: true, registeredAt: true, walletAddress: true, registrationCommitment: true },
      });
      const byAccount = new Map(rows.map((row) => [row.accountId, row]));
      expect(byAccount.get(accountA)).toMatchObject({
        expiredAt: now,
        registeredAt: null,
        walletAddress: stale.walletAddress,
        registrationCommitment: stale.registrationCommitment,
      });
      expect(byAccount.get(accountB)).toMatchObject({ expiredAt: null, registeredAt: confirmed.registeredAt });
      expect(byAccount.get(accountC)).toMatchObject({ expiredAt: null, registeredAt: null });
      expect(fresh.expiredAt).toBeNull();

      const audit = await auditRows(accountA, "expired");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorAccountId: null,
        resourceType: "account",
        resourceId: accountA,
        createdAt: now,
        changes: {
          wallet_address: stale.walletAddress,
          registration_commitment: stale.registrationCommitment,
          requested_at: longAgo.toISOString(),
        },
      });
      expect(await auditRows(accountB, "expired")).toHaveLength(0);
      expect(await auditRows(accountC, "expired")).toHaveLength(0);
    });

    it("does not expire or audit an already expired claim a second time", async () => {
      await createClaim(accountA, { requestedAt: longAgo });
      await walletRepository.expirePendingWalletRegistrations({ cutoff, now });

      await walletRepository.expirePendingWalletRegistrations({ cutoff, now: new Date("2026-11-16T12:15:00.000Z") });

      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        expiredAt: now,
      });
      expect(await auditRows(accountA, "expired")).toHaveLength(1);
    });

    it("takes the expired claim out of the overdue count and the watcher's lookup", async () => {
      const stale = await createClaim(accountA, { requestedAt: longAgo });

      await walletRepository.expirePendingWalletRegistrations({ cutoff, now });

      expect(await settlementRepository.countPendingWalletRegistrationsBefore(cutoff)).toBe(0);
      expect(await settlementRepository.findWalletRegistrationByCommitment(stale.registrationCommitment)).toBeNull();
    });
  });

  describe("an expired claim", () => {
    it("reads as no wallet to the customer side, and as expired to staff", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      expect(await walletRepository.getStatus(accountA)).toBeNull();
      expect(await walletRepository.findByAccountId(accountA)).toBeNull();
      expect(await walletRepository.findByAccountId(accountA, { includeExpired: true })).toMatchObject({
        walletAddress: expired.walletAddress,
        expiredAt: now,
        registeredAt: null,
      });
    });

    it("cannot be confirmed by a late event naming its commitment", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      await expect(
        settlementRepository.confirmWalletRegistration({
          accountId: accountA,
          walletAddress: expired.walletAddress,
          registrationCommitment: expired.registrationCommitment,
          registeredAt: new Date(),
          evidence: nextEvidence(),
        }),
      ).resolves.toBe("stale");
      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        registeredAt: null,
        expiredAt: now,
      });
    });

    it("cannot be reconciled by staff", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      await expect(
        walletRepository.reconcileWalletRegistration({
          accountId: accountA,
          expectedWalletAddress: expired.walletAddress,
          expectedRegistrationCommitment: expired.registrationCommitment,
          evidence: nextEvidence(),
          registeredAt: new Date("2026-11-01T10:05:00.000Z"),
          changedAt: new Date("2026-11-01T10:06:00.000Z"),
          actorAccountId: staffAccount,
        }),
      ).rejects.toBeInstanceOf(WalletRegistrationChangedError);
      expect(await auditRows(accountA, "reconciled")).toHaveLength(0);
    });

    it("can never sit on a confirmed row: the database refuses expired_at beside registered_at", async () => {
      await createClaim(accountA, { requestedAt: longAgo, registeredAt: longAgo });

      await expect(
        authPool.query("UPDATE settlement.wallet_registrations SET expired_at = now() WHERE account_id = $1", [accountA]),
      ).rejects.toMatchObject({ code: "23514", constraint: EXPIRED_ONLY_PENDING_CHECK });
    });
  });

  describe("re-registration after expiry", () => {
    it("takes a different address without fresh authentication, as a new request with a new commitment", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const address = nextAddress();

      const renewed = await register(accountA, address, false);

      expect(renewed.walletAddress).toBe(address);
      expect(renewed.registrationCommitment).not.toBe(expired.registrationCommitment);
      expect(renewed.registeredAt).toBeNull();
      expect(renewed).not.toHaveProperty("expiredAt");
      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        walletAddress: address,
        registrationCommitment: renewed.registrationCommitment,
        expiredAt: null,
      });
      expect(await walletRepository.getStatus(accountA)).toMatchObject({ registeredAt: null });
      const audit = await auditRows(accountA, "requested");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorAccountId: accountA,
        changes: { wallet_address: address, previous_expired_wallet_address: expired.walletAddress },
      });
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
    });

    it("issues a new commitment even for the same address: the expired one stays dead", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      const renewed = await register(accountA, expired.walletAddress);

      expect(renewed.walletAddress).toBe(expired.walletAddress);
      expect(renewed.registrationCommitment).not.toBe(expired.registrationCommitment);
      expect(await settlementRepository.findWalletRegistrationByCommitment(expired.registrationCommitment)).toBeNull();
      expect(await settlementRepository.findWalletRegistrationByCommitment(renewed.registrationCommitment)).toMatchObject({
        accountId: accountA,
      });
    });

    it("is refused, leaving the expired row as it was, when another account has since confirmed the address", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      await database.walletRegistration.create({
        data: {
          accountId: accountB,
          walletAddress: expired.walletAddress,
          registrationCommitment: nextCommitment(),
          registeredAt: new Date(),
        },
      });

      await expect(register(accountA, expired.walletAddress)).rejects.toMatchObject({
        reason: "address_claimed",
      });
      await expect(register(accountA, expired.walletAddress)).rejects.toBeInstanceOf(WalletAddressConflictError);
      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        registrationCommitment: expired.registrationCommitment,
        expiredAt: now,
      });
    });
  });
});
