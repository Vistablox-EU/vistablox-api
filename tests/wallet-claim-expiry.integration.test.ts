import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { GetProfileService } from "../src/modules/profile/application/get-profile.service.js";
import { PrismaProfileRepository } from "../src/modules/profile/repository/prisma-profile.repository.js";
import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { WalletRegistryExpiryGate } from "../src/modules/settlement/application/wallet-registry-expiry-gate.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import { ExpirePendingWalletRegistrationsService } from "../src/modules/wallet/application/expire-pending-wallet-registrations.service.js";
import { GetWalletAccountForOperationsService } from "../src/modules/wallet/application/get-wallet-account-for-operations.service.js";
import { GetWalletStatusService } from "../src/modules/wallet/application/get-wallet-status.service.js";
import {
  ReconcileWalletRegistrationService,
  type WalletRegistrationChainVerifier,
} from "../src/modules/wallet/application/reconcile-wallet-registration.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import {
  WalletAddressConflictError,
  WalletRegistrationChangedError,
  WalletReplacementFreshAuthenticationRequiredError,
} from "../src/modules/wallet/repository/wallet.repository.js";
import { makeFakeChain } from "./support/wallet-registration-fakes.js";
import { buildWalletFreshAuthApp } from "./support/wallet-fresh-auth-app.js";

// Pending wallet claims expire (#177). The sweep is global, so vitest.config.ts
// runs this file on its own, after the parallel files. As a second guard the
// stale claims here are from 1980 and the sweep's cutoff is 1980-01-02, so it
// cannot reach a realistic fixture another suite left behind.
const databaseUrl = process.env.TEST_DATABASE_URL;
const EXPIRED_ONLY_PENDING_CHECK = "wallet_registrations_expired_only_pending_check";

describe.skipIf(databaseUrl === undefined)("wallet claim expiry PostgreSQL integration", () => {
  const suffix = randomUUID();
  const hex = suffix.replaceAll("-", "");
  // Four named accounts, and twelve more for the tests that need many claims at
  // once (a claim is one row per account).
  const accountIds = Array.from({ length: 16 }, (_, index) => `acct_expiry${index}_${suffix}`);
  const betterAuthUserIds = accountIds.map((_, index) => `auth_expiry${index}_${suffix}`);
  const accountA = accountIds[0]!;
  const accountB = accountIds[1]!;
  const accountC = accountIds[2]!;
  const staffAccount = accountIds[3]!;
  const manyAccounts = accountIds.slice(4);

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

  const sweep = (sweepCutoff = cutoff, sweepNow = now, batchSize = 500) =>
    walletRepository.expirePendingWalletRegistrations({ cutoff: sweepCutoff, now: sweepNow, batchSize });

  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const walletRepository = new PrismaWalletRepository(database);
  const settlementRepository = new PrismaSettlementRepository(database);

  // A session that passed the fresh-authentication probe, and one that did not.
  // Which one a test uses is part of what it pins, so there is no default.
  const register = (accountId: string, walletAddress: string, freshAuthentication: boolean) =>
    walletRepository.registerWallet({
      accountId,
      walletAddress,
      registrationCommitment: nextCommitment(),
      requestedAt: new Date(),
      freshAuthentication,
    });
  const registerFresh = (accountId: string, walletAddress: string) => register(accountId, walletAddress, true);
  const registerStale = (accountId: string, walletAddress: string) => register(accountId, walletAddress, false);

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

      const result = await sweep();

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
      await sweep();

      await sweep(cutoff, new Date("2026-11-16T12:15:00.000Z"));

      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        expiredAt: now,
      });
      expect(await auditRows(accountA, "expired")).toHaveLength(1);
    });

    it("takes the expired claim out of the overdue count and the watcher's lookup", async () => {
      const stale = await createClaim(accountA, { requestedAt: longAgo });

      await sweep();

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

    it("cannot be confirmed by a late event naming its commitment: the write answers expired, not stale", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      await expect(
        settlementRepository.confirmWalletRegistration({
          accountId: accountA,
          walletAddress: expired.walletAddress,
          registrationCommitment: expired.registrationCommitment,
          registeredAt: new Date(),
          evidence: nextEvidence(),
        }),
      ).resolves.toBe("expired");
      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        registeredAt: null,
        expiredAt: now,
      });
      expect(await auditRows(accountA, "confirmed")).toHaveLength(0);
    });

    it("still tells a replaced claim from an expired one: the write for a claim the account replaced answers stale", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      await registerFresh(accountA, nextAddress());

      await expect(
        settlementRepository.confirmWalletRegistration({
          accountId: accountA,
          walletAddress: expired.walletAddress,
          registrationCommitment: expired.registrationCommitment,
          registeredAt: new Date(),
          evidence: nextEvidence(),
        }),
      ).resolves.toBe("stale");
    });

    it("can never sit on a confirmed row: the database refuses expired_at beside registered_at", async () => {
      await createClaim(accountA, { requestedAt: longAgo, registeredAt: longAgo });

      await expect(
        authPool.query("UPDATE settlement.wallet_registrations SET expired_at = now() WHERE account_id = $1", [accountA]),
      ).rejects.toMatchObject({ code: "23514", constraint: EXPIRED_ONLY_PENDING_CHECK });
    });
  });

  // AD-287 (decided 2026-11-17): registering again after the claim expired
  // needs fresh authentication when the address differs from the expired one,
  // the same rule as replacing a live pending claim (#163). A replay of the
  // same address stays free. The refusal writes nothing and, being decided
  // from the account's own row before any other account's addresses are
  // looked at, tells a stale session nothing about them.
  describe("re-registration after expiry", () => {
    const snapshot = async (accountId: string) => {
      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId } });
      return {
        walletAddress: row.walletAddress,
        registrationCommitment: row.registrationCommitment,
        requestedAt: row.requestedAt,
        registeredAt: row.registeredAt,
        expiredAt: row.expiredAt,
      };
    };
    const allWalletAudit = (accountId: string) =>
      database.auditLog.count({ where: { resourceId: accountId, action: { startsWith: "settlement.wallet_registration_" } } });
    const confirmedElsewhere = (accountId: string, walletAddress: string) =>
      database.walletRegistration.create({
        data: { accountId, walletAddress, registrationCommitment: nextCommitment(), registeredAt: new Date() },
      });

    it("takes a different address on a fresh session, as a new request with a new commitment", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const address = nextAddress();

      const renewed = await registerFresh(accountA, address);

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

    it("refuses a different address on a stale session with the typed error and writes nothing", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const before = await snapshot(accountA);
      const refusedCommitment = nextCommitment();

      await expect(
        walletRepository.registerWallet({
          accountId: accountA,
          walletAddress: nextAddress(),
          registrationCommitment: refusedCommitment,
          requestedAt: new Date(),
          freshAuthentication: false,
        }),
      ).rejects.toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);

      expect(await snapshot(accountA)).toEqual(before);
      expect(before).toMatchObject({ registrationCommitment: expired.registrationCommitment, expiredAt: now });
      expect(await settlementRepository.findWalletRegistrationByCommitment(refusedCommitment)).toBeNull();
      expect(await allWalletAudit(accountA)).toBe(0);
    });

    it("carries nothing about the claim in the refusal: no address, no account id, no commitment", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const submitted = nextAddress();

      const error = await registerStale(accountA, submitted).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const secret of [expired.walletAddress, expired.registrationCommitment, submitted, accountA]) {
        expect(text).not.toContain(secret);
      }
    });

    it("lets a stale session replay the expired claim's address, in any hex case and with whitespace, and gets a new commitment", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const spelling = ` 0x${expired.walletAddress.slice(2).toUpperCase()} `;
      expect(spelling.trim()).not.toBe(expired.walletAddress);

      const renewed = await registerStale(accountA, spelling);

      expect(renewed.walletAddress).toBe(expired.walletAddress);
      expect(renewed.registrationCommitment).not.toBe(expired.registrationCommitment);
      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        walletAddress: expired.walletAddress,
        registrationCommitment: renewed.registrationCommitment,
        expiredAt: null,
      });
      expect(await settlementRepository.findWalletRegistrationByCommitment(expired.registrationCommitment)).toBeNull();
      const audit = await auditRows(accountA, "requested");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ changes: { wallet_address: expired.walletAddress } });
    });

    // The freshness rule against the claim's own state: only a different
    // address needs it, and only for an own claim that is still pending or
    // expired. A confirmed claim has its own outcomes (409), a first
    // registration has no claim to replace.
    it.each([
      { claim: "expired", address: "same", session: "stale", outcome: "renewed" },
      { claim: "expired", address: "same", session: "fresh", outcome: "renewed" },
      { claim: "expired", address: "different", session: "fresh", outcome: "renewed" },
      { claim: "expired", address: "different", session: "stale", outcome: "refused" },
      { claim: "pending", address: "different", session: "stale", outcome: "refused" },
      { claim: "pending", address: "different", session: "fresh", outcome: "replaced" },
      { claim: "pending", address: "same", session: "stale", outcome: "replayed" },
      { claim: "none", address: "different", session: "stale", outcome: "created" },
    ] as const)(
      "$claim claim, $address address, $session session -> $outcome",
      async ({ claim, address, session, outcome }) => {
        const own =
          claim === "none"
            ? null
            : await createClaim(accountA, claim === "expired" ? { requestedAt: longAgo, expiredAt: now } : { requestedAt: longAgo });
        const submitted = own !== null && address === "same" ? own.walletAddress : nextAddress();
        const before = own === null ? null : await snapshot(accountA);

        const attempt = register(accountA, submitted, session === "fresh");

        if (outcome === "refused") {
          await expect(attempt).rejects.toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
          expect(await snapshot(accountA)).toEqual(before);
          expect(await allWalletAudit(accountA)).toBe(0);
          return;
        }
        const result = await attempt;
        expect(result.walletAddress).toBe(submitted);
        expect(result.registeredAt).toBeNull();
        if (outcome === "replayed") {
          expect(result.registrationCommitment).toBe(own?.registrationCommitment);
          expect(await snapshot(accountA)).toEqual(before);
        } else {
          expect(result.registrationCommitment).not.toBe(own?.registrationCommitment);
        }
        expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
          expiredAt: null,
          registeredAt: null,
        });
      },
    );

    it("asks for freshness before it says an address is confirmed elsewhere: a stale session learns nothing about other accounts", async () => {
      await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const taken = nextAddress();
      await confirmedElsewhere(accountB, taken);
      const before = await snapshot(accountA);

      await expect(registerStale(accountA, taken)).rejects.toBeInstanceOf(
        WalletReplacementFreshAuthenticationRequiredError,
      );
      await expect(registerStale(accountA, nextAddress())).rejects.toBeInstanceOf(
        WalletReplacementFreshAuthenticationRequiredError,
      );

      expect(await snapshot(accountA)).toEqual(before);
      expect(await allWalletAudit(accountA)).toBe(0);
    });

    it("tells a fresh session that the address is confirmed elsewhere, and leaves the expired row as it was", async () => {
      await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const taken = nextAddress();
      await confirmedElsewhere(accountB, taken);
      const before = await snapshot(accountA);

      await expect(registerFresh(accountA, taken)).rejects.toMatchObject({ reason: "address_claimed" });

      expect(await snapshot(accountA)).toEqual(before);
      expect(await allWalletAudit(accountA)).toBe(0);
    });

    it("issues a new commitment even for the same address: the expired one stays dead", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      const renewed = await registerStale(accountA, expired.walletAddress);

      expect(renewed.walletAddress).toBe(expired.walletAddress);
      expect(renewed.registrationCommitment).not.toBe(expired.registrationCommitment);
      expect(await settlementRepository.findWalletRegistrationByCommitment(expired.registrationCommitment)).toBeNull();
      expect(await settlementRepository.findWalletRegistrationByCommitment(renewed.registrationCommitment)).toMatchObject({
        accountId: accountA,
      });
    });

    it("is refused, leaving the expired row as it was, when another account has since confirmed the address", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      await confirmedElsewhere(accountB, expired.walletAddress);

      await expect(registerStale(accountA, expired.walletAddress)).rejects.toMatchObject({
        reason: "address_claimed",
      });
      await expect(registerStale(accountA, expired.walletAddress)).rejects.toBeInstanceOf(WalletAddressConflictError);
      expect(await database.walletRegistration.findUnique({ where: { accountId: accountA } })).toMatchObject({
        registrationCommitment: expired.registrationCommitment,
        expiredAt: now,
      });
    });

    it("refuses every one of 8 parallel stale registrations of other addresses, and the expired row stays exactly as it was", async () => {
      await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const before = await snapshot(accountA);

      const results = await Promise.allSettled(Array.from({ length: 8 }, () => registerStale(accountA, nextAddress())));

      for (const result of results) {
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      }
      expect(await snapshot(accountA)).toEqual(before);
      expect(await allWalletAudit(accountA)).toBe(0);
    });

    it("never lets a stale request win against a fresh one: with 1 fresh and 3 stale registrations of other addresses in parallel, the fresh address stands", async () => {
      await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const freshAddress = nextAddress();

      const results = await Promise.allSettled([
        registerStale(accountA, nextAddress()),
        registerFresh(accountA, freshAddress),
        registerStale(accountA, nextAddress()),
        registerStale(accountA, nextAddress()),
      ]);

      const fresh = results[1]!;
      expect(fresh.status).toBe("fulfilled");
      // A stale request that ran after the fresh one found a pending claim on
      // another address and was refused as a replacement; one that ran before
      // it found the expired claim. Either way it was refused, never applied.
      for (const index of [0, 2, 3]) {
        const result = results[index]!;
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      }
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        walletAddress: freshAddress,
        expiredAt: null,
        registeredAt: null,
      });
    });

    describe("through the real app, real wallet repository and real fresh-authentication wiring", () => {
      const app = (accountId: string, sessionAgeMs: number) =>
        buildWalletFreshAuthApp({
          walletRepository,
          accountId,
          identity: { sessionCreatedAt: new Date(Date.now() - sessionAgeMs) },
        }).build();
      const post = (target: ReturnType<typeof app>, address: string) =>
        request(target).post("/v1/investor-profile/wallet").send({ wallet_address: address });

      it("answers a stale session's different address with the 403 envelope and leaves row and audit unchanged; the same request on a fresh session is a 201", async () => {
        const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
        const before = await snapshot(accountA);
        const address = nextAddress();

        const refused = await post(app(accountA, 10 * 60_000), address);

        expect(refused.status).toBe(403);
        expect(Object.keys(refused.body).sort()).toEqual(["code", "detail", "status", "title", "trace_id", "type"]);
        expect(refused.body).toMatchObject({
          code: "authentication.fresh_auth_required",
          status: 403,
        });
        expect(JSON.stringify(refused.body)).not.toContain(expired.walletAddress);
        expect(JSON.stringify(refused.body)).not.toContain(expired.registrationCommitment);
        expect(await snapshot(accountA)).toEqual(before);
        expect(await allWalletAudit(accountA)).toBe(0);

        const retried = await post(app(accountA, 30_000), address);

        expect(retried.status).toBe(201);
        expect(retried.body.data).toMatchObject({ wallet_address: address, status: "pending" });
        expect(retried.body.data.registration_commitment).not.toBe(expired.registrationCommitment);
      });

      it("serves a stale session's replay of the expired address, in another case, as a 201 with a new commitment", async () => {
        const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

        const response = await post(app(accountA, 10 * 60_000), `0x${expired.walletAddress.slice(2).toUpperCase()}`);

        expect(response.status).toBe(201);
        expect(response.body.data).toMatchObject({ wallet_address: expired.walletAddress, status: "pending" });
        expect(response.body.data.registration_commitment).not.toBe(expired.registrationCommitment);
      });
    });
  });

  // The lifetime, its boundary, the batch and the parallel runs, through the
  // service with a real repository. `now` is in 1980 so the cutoff cannot reach
  // a realistic claim another suite left behind.
  describe("the sweep through the service", () => {
    const sweepNow = new Date("1980-01-03T00:00:00.000Z");
    const TTL_MS = 24 * 60 * 60 * 1000;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const openGate = { assess: async () => ({ mayExpire: true, reasons: [] as string[] }) };
    const service = (batchSize = 500) =>
      new ExpirePendingWalletRegistrationsService(walletRepository, openGate, logger, () => sweepNow, {
        expireAfterHours: 24,
        batchSize,
      });

    // A claim requested ageMs before the sweep: exactly one lifetime old has
    // expired (the cutoff is inclusive), a millisecond younger has not.
    it.each([
      { ageMs: TTL_MS + 1, expires: true },
      { ageMs: TTL_MS, expires: true },
      { ageMs: TTL_MS - 1, expires: false },
      { ageMs: 0, expires: false },
    ])("a claim requested $ageMs ms before the sweep: expires $expires", async ({ ageMs, expires }) => {
      await createClaim(accountA, { requestedAt: new Date(sweepNow.getTime() - ageMs) });

      const summary = await service().execute("trace");

      expect(summary.acted).toBeGreaterThanOrEqual(expires ? 1 : 0);
      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
      expect(row.expiredAt).toEqual(expires ? sweepNow : null);
      expect(await auditRows(accountA, "expired")).toHaveLength(expires ? 1 : 0);
    });

    it("expires at most the batch, oldest first, and the next runs take the rest, each claim once", async () => {
      const claims = await Promise.all(
        manyAccounts.map((accountId, index) =>
          createClaim(accountId, { requestedAt: new Date(longAgo.getTime() + index * 1000) }),
        ),
      );
      expect(claims).toHaveLength(12);
      const expiredNow = async () =>
        (await database.walletRegistration.findMany({ where: { accountId: { in: manyAccounts }, expiredAt: { not: null } } }))
          .map((row) => row.accountId)
          .sort();

      const first = await service(5).execute("trace");
      expect(first).toEqual({ checked: 12, acted: 5 });
      expect(await expiredNow()).toEqual(manyAccounts.slice(0, 5).sort());

      const second = await service(5).execute("trace");
      expect(second).toEqual({ checked: 7, acted: 5 });
      const third = await service(5).execute("trace");
      expect(third).toEqual({ checked: 2, acted: 2 });
      const fourth = await service(5).execute("trace");
      expect(fourth).toEqual({ checked: 0, acted: 0 });

      expect(await expiredNow()).toEqual([...manyAccounts].sort());
      for (const accountId of manyAccounts) expect(await auditRows(accountId, "expired")).toHaveLength(1);
    });

    it("never expires a claim twice when runs overlap: every claim has exactly one expired audit row", async () => {
      await Promise.all(
        manyAccounts.map((accountId, index) =>
          createClaim(accountId, { requestedAt: new Date(longAgo.getTime() + index * 1000) }),
        ),
      );

      const runs = await Promise.all(Array.from({ length: 4 }, () => service(5).execute("trace")));
      // Whatever a run skipped because another held the row, the next runs finish.
      while ((await service(5).execute("trace")).acted > 0) {
        /* drain */
      }

      expect(runs.reduce((total, run) => total + run.acted, 0)).toBeLessThanOrEqual(12);
      for (const accountId of manyAccounts) {
        expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId } })).toMatchObject({ expiredAt: sweepNow });
        expect(await auditRows(accountId, "expired")).toHaveLength(1);
      }
    });

    it("refuses a batch that is not a positive integer rather than expire everything or nothing", async () => {
      await createClaim(accountA, { requestedAt: longAgo });

      for (const batchSize of [0, -1, 1.5, Number.NaN]) {
        await expect(sweep(cutoff, now, batchSize)).rejects.toThrow(RangeError);
      }

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: null });
    });
  });

  // The sweep skips while the registry watcher is stale or lagging, or when its
  // health cannot be read (AD-287, decided 2026-11-17). Real claims and a real
  // sweep, the real health policy through the gate, and the health reading
  // scripted per case: the heartbeat row itself is one shared row that
  // wallet-registry-health.integration.test.ts alone owns (see
  // wallet-registry-heartbeat-isolation.test.ts), and that file also checks the
  // gate against the real row.
  describe("the sweep while the watcher is not trusted", () => {
    const MINUTE = 60_000;
    const sweepNow = new Date("1980-01-03T00:00:00.000Z");
    const thresholds = {
      watcherStaleAfterMs: 10 * MINUTE,
      cursorLagAlertBlocks: 900n,
      cursorAheadToleranceBlocks: 32n,
      pendingOverdueAlertCount: 1,
      unmatchedEventsAlertCount: 5,
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    type Reader = ConstructorParameters<typeof WalletRegistryExpiryGate>[0];
    // `history` is whether the database holds any trace of a watcher run; it
    // defaults to "yes" for a heartbeat and "no" for none, and a case names it
    // when the two differ (a heartbeat row that cannot be read, a cursor only).
    const readerWith = (
      heartbeat: { ageMs: number; lagBlocks: bigint } | null,
      history: boolean = heartbeat !== null,
    ): Reader => ({
      readWalletRegistryHealth: async () => ({
        heartbeat:
          heartbeat === null
            ? null
            : {
                completedAt: new Date(sweepNow.getTime() - heartbeat.ageMs),
                cursorBlock: 50_000n - heartbeat.lagBlocks,
                safeHeadBlock: 50_000n,
                eventsFound: 0,
              },
        watcherHistoryRecorded: history,
        pendingTotal: 1,
        pendingOverdue: 1,
        oldestPendingRequestedAt: longAgo,
        unresolvedMismatches: { count: 0, accountIds: [] },
      }),
    });

    const RUNNING = { registryConfigured: true, watcherRunnable: true };
    const WITHOUT_CHAIN = { registryConfigured: true, watcherRunnable: false };
    const REGISTRY_OFF = { registryConfigured: false, watcherRunnable: false };
    const sweepWith = (reader: Reader, worker = RUNNING) =>
      new ExpirePendingWalletRegistrationsService(
        walletRepository,
        new WalletRegistryExpiryGate(reader, { thresholds, ...worker, pendingOverdueAfterMs: 5 * MINUTE }),
        logger,
        () => sweepNow,
        { expireAfterHours: 24 },
      );

    afterEach(() => {
      logger.info.mockClear();
      logger.warn.mockClear();
    });

    it.each([
      { name: "a fresh heartbeat, the cursor level with the safe head", ageMs: MINUTE, lag: 0n, expires: true },
      { name: "a heartbeat one ms short of the stale threshold", ageMs: 10 * MINUTE - 1, lag: 0n, expires: true },
      { name: "a heartbeat exactly at the stale threshold", ageMs: 10 * MINUTE, lag: 0n, expires: false },
      { name: "a heartbeat from days ago", ageMs: 3 * 24 * 60 * MINUTE, lag: 0n, expires: false },
      { name: "a cursor 899 blocks behind", ageMs: MINUTE, lag: 899n, expires: true },
      { name: "a cursor exactly 900 blocks behind", ageMs: MINUTE, lag: 900n, expires: false },
      { name: "a cursor 33 blocks ahead of the safe head", ageMs: MINUTE, lag: -33n, expires: false },
      { name: "a cursor 32 blocks ahead of the safe head (the watcher's own overlap)", ageMs: MINUTE, lag: -32n, expires: true },
    ])("$name: expires $expires", async ({ ageMs, lag, expires }) => {
      await createClaim(accountA, { requestedAt: longAgo });

      const summary = await sweepWith(readerWith({ ageMs, lagBlocks: lag })).execute("trace");

      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
      expect(row.expiredAt).toEqual(expires ? sweepNow : null);
      expect(await auditRows(accountA, "expired")).toHaveLength(expires ? 1 : 0);
      if (expires) {
        expect(logger.info).not.toHaveBeenCalled();
      } else {
        expect(summary).toEqual({ checked: 0, acted: 0 });
        expect(logger.info).toHaveBeenCalledTimes(1);
      }
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("expires nothing, and says once why, when the watcher has no readable heartbeat", async () => {
      await createClaim(accountA, { requestedAt: longAgo });

      await expect(sweepWith(readerWith(null)).execute("trace")).resolves.toEqual({ checked: 0, acted: 0 });

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: null });
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0]![0]).toMatchObject({ reasons: ["wallet_registry.watcher_stalled"] });
    });

    it("expires nothing, and warns once, when the health snapshot cannot be read at all", async () => {
      await createClaim(accountA, { requestedAt: longAgo });
      const unreadable: Reader = { readWalletRegistryHealth: async () => Promise.reject(new Error("database unavailable")) };

      await expect(sweepWith(unreadable).execute("trace")).resolves.toEqual({ checked: 0, acted: 0 });

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: null });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]![0]).toMatchObject({ reasons: ["health_unreadable"] });
    });

    // A worker with the registry address but without the CHAIN_* settings has no
    // watcher, yet a watcher that ran before left its heartbeat and its cursor,
    // and reads everything it missed the day it runs again. The claims wait.
    it.each([
      { name: "a heartbeat from days ago", reader: readerWith({ ageMs: 5 * 24 * 60 * MINUTE, lagBlocks: 50_000n }) },
      { name: "a heartbeat from a minute ago", reader: readerWith({ ageMs: MINUTE, lagBlocks: 0n }) },
      { name: "a heartbeat row that cannot be read, or a cursor and no heartbeat", reader: readerWith(null, true) },
    ])("expires nothing where the registry address is set but no watcher can run, and $name is on record", async ({ reader }) => {
      await createClaim(accountA, { requestedAt: longAgo });

      await expect(sweepWith(reader, WITHOUT_CHAIN).execute("trace")).resolves.toEqual({ checked: 0, acted: 0 });

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: null });
      expect(await auditRows(accountA, "expired")).toHaveLength(0);
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info.mock.calls[0]![0]).toMatchObject({ reasons: ["wallet_registry.watcher_not_configured"] });
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("expires as usual where the registry address is set, no watcher can run, and none ever did", async () => {
      await createClaim(accountA, { requestedAt: longAgo });

      await sweepWith(readerWith(null), WITHOUT_CHAIN).execute("trace");

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: sweepNow });
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("expires as usual where the registry address is unset, whatever an old heartbeat says", async () => {
      await createClaim(accountA, { requestedAt: longAgo });

      await sweepWith(readerWith({ ageMs: 5 * 24 * 60 * MINUTE, lagBlocks: 50_000n }), REGISTRY_OFF).execute("trace");

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: sweepNow });
    });

    it("expires the claims it held back on the first run after the watcher is configured and fresh again", async () => {
      await createClaim(accountA, { requestedAt: longAgo });
      await sweepWith(readerWith({ ageMs: 5 * 24 * 60 * MINUTE, lagBlocks: 50_000n }), WITHOUT_CHAIN).execute("no chain settings");
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: null });

      const recovered = await sweepWith(readerWith({ ageMs: MINUTE, lagBlocks: 0n }), RUNNING).execute("watcher back");

      expect(recovered.acted).toBeGreaterThanOrEqual(1);
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: sweepNow });
    });

    it("catches up on the first run after the watcher recovers, with no claim lost to the wait", async () => {
      await createClaim(accountA, { requestedAt: longAgo });
      await sweepWith(readerWith({ ageMs: 3 * 24 * 60 * MINUTE, lagBlocks: 0n })).execute("while stale");
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: null });

      const recovered = await sweepWith(readerWith({ ageMs: MINUTE, lagBlocks: 0n })).execute("recovered");

      expect(recovered.acted).toBeGreaterThanOrEqual(1);
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({ expiredAt: sweepNow });
    });
  });

  // Staff can reconcile an expired claim on matching on-chain evidence
  // (AD-287, decided 2026-11-17). It confirms the claim, which reinstates it.
  describe("reconciling an expired claim", () => {
    const registeredAt = new Date("2026-11-17T10:00:00.000Z");
    const changedAt = new Date("2026-11-17T10:01:00.000Z");
    const reconcile = (
      accountId: string,
      claim: { walletAddress: string; registrationCommitment: string },
      evidence = nextEvidence(),
      actorAccountId = staffAccount,
    ) =>
      walletRepository.reconcileWalletRegistration!({
        accountId,
        actorAccountId,
        expectedWalletAddress: claim.walletAddress,
        expectedRegistrationCommitment: claim.registrationCommitment,
        evidence,
        registeredAt,
        changedAt,
      });

    it("confirms it: registered_at and the evidence are written, expired_at is cleared, and the audit row says which expiry it undid", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const evidence = nextEvidence();

      const result = await reconcile(accountA, expired, evidence);

      expect(result).toMatchObject({ kind: "reconciled", outcome: "confirmed" });
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        walletAddress: expired.walletAddress,
        registrationCommitment: expired.registrationCommitment,
        registeredAt,
        expiredAt: null,
        registrationTxHash: evidence.transactionHash,
        registrationBlockHash: evidence.blockHash,
        registrationBlockNumber: evidence.blockNumber,
        registrationLogIndex: evidence.logIndex,
      });
      const audit = await auditRows(accountA, "reconciled");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorAccountId: staffAccount,
        resourceType: "wallet_registration",
        changes: {
          tx_hash: evidence.transactionHash,
          registered_at: registeredAt.toISOString(),
          reinstated_from_expired_at: now.toISOString(),
        },
      });
      // The expiry's own audit row is history and stays.
      expect(await walletRepository.getStatus(accountA)).toMatchObject({ registeredAt });
      expect(await walletRepository.findByAccountId(accountA)).toMatchObject({ registeredAt, expiredAt: null });
    });

    it("leaves a plain pending claim's audit row without any reinstatement field", async () => {
      const pending = await createClaim(accountA, { requestedAt: longAgo });

      await reconcile(accountA, pending);

      const audit = await auditRows(accountA, "reconciled");
      expect(audit).toHaveLength(1);
      expect(audit[0]!.changes).not.toHaveProperty("reinstated_from_expired_at");
    });

    it("is a no-op the second time: the claim is confirmed with this very event", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const evidence = nextEvidence();
      await reconcile(accountA, expired, evidence);

      await expect(reconcile(accountA, expired, evidence)).resolves.toMatchObject({ kind: "reconciled", outcome: "unchanged" });

      expect(await auditRows(accountA, "reconciled")).toHaveLength(1);
    });

    it("keeps the confirmed-address uniqueness: an address another account has confirmed is refused, audited with the staff actor, and the claim stays expired", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      await database.walletRegistration.create({
        data: { accountId: accountB, walletAddress: expired.walletAddress, registrationCommitment: nextCommitment(), registeredAt: new Date() },
      });

      await expect(reconcile(accountA, expired)).rejects.toBeInstanceOf(WalletAddressConflictError);

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        registeredAt: null,
        expiredAt: now,
        registrationTxHash: null,
      });
      expect(await auditRows(accountA, "reconciled")).toHaveLength(0);
      const conflict = await auditRows(accountA, "confirmation_conflict");
      expect(conflict).toHaveLength(1);
      expect(conflict[0]).toMatchObject({ actorAccountId: staffAccount, changes: { holder_account_id: accountB, source: "manual_reconcile" } });
    });

    it("keeps the chain-event uniqueness: an event that already backs another account's registration is refused and the claim stays expired", async () => {
      const taken = nextEvidence();
      await database.walletRegistration.create({
        data: {
          accountId: accountB,
          walletAddress: nextAddress(),
          registrationCommitment: nextCommitment(),
          registeredAt: new Date(),
          registrationTxHash: taken.transactionHash,
          registrationBlockHash: taken.blockHash,
          registrationBlockNumber: taken.blockNumber,
          registrationLogIndex: taken.logIndex,
        },
      });
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      await expect(reconcile(accountA, expired, taken)).resolves.toEqual({ kind: "conflict", reason: "event_taken" });

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        registeredAt: null,
        expiredAt: now,
      });
      expect(await auditRows(accountA, "reconciled")).toHaveLength(0);
    });

    it("refuses, and writes nothing, when the customer registered again after the evidence was verified: the new commitment is not the one the chain showed", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const renewed = await registerFresh(accountA, nextAddress());

      await expect(reconcile(accountA, expired)).rejects.toBeInstanceOf(WalletRegistrationChangedError);

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        walletAddress: renewed.walletAddress,
        registrationCommitment: renewed.registrationCommitment,
        registeredAt: null,
        expiredAt: null,
        registrationTxHash: null,
      });
      expect(await auditRows(accountA, "reconciled")).toHaveLength(0);
    });

    it("refuses a claim whose address or commitment is not the one the evidence was verified against", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      await expect(reconcile(accountA, { ...expired, registrationCommitment: nextCommitment() })).rejects.toBeInstanceOf(
        WalletRegistrationChangedError,
      );
      await expect(reconcile(accountA, { ...expired, walletAddress: nextAddress() })).rejects.toBeInstanceOf(
        WalletRegistrationChangedError,
      );

      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        registeredAt: null,
        expiredAt: now,
      });
    });

    describe("through the staff services", () => {
      const verified = nextEvidence();
      const verifier: WalletRegistrationChainVerifier = {
        verify: vi.fn(async (input) => {
          void input;
          return { ...verified, registeredAt };
        }),
      };
      const reconcileService = new ReconcileWalletRegistrationService(walletRepository, verifier, () => changedAt);
      const operations = new GetWalletAccountForOperationsService(walletRepository);

      it("reads the expired claim, checks the chain against its own address and commitment, and confirms it; the staff view follows", async () => {
        const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
        expect((await operations.execute(accountA)).data).toMatchObject({ status: "expired", expired_at: now.toISOString() });

        const result = await reconcileService.execute({ accountId: accountA, txHash: verified.transactionHash, actorAccountId: staffAccount });

        expect(verifier.verify).toHaveBeenLastCalledWith({
          txHash: verified.transactionHash,
          walletAddress: expired.walletAddress,
          commitment: expired.registrationCommitment,
        });
        expect(result.data).toMatchObject({
          account_id: accountA,
          wallet_address: expired.walletAddress,
          status: "registered",
          outcome: "confirmed",
          registered_at: registeredAt.toISOString(),
        });
        expect((await operations.execute(accountA)).data).toMatchObject({
          status: "registered",
          registered_at: registeredAt.toISOString(),
          expired_at: null,
          registration_evidence: { transaction_hash: verified.transactionHash },
        });
      });

      it("answers 409 wallet.registration_changed, not 404, when the customer registered again between the read and the write", async () => {
        const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
        const racing: WalletRegistrationChainVerifier = {
          verify: async () => {
            // The chain check is the slow part: the customer registers again meanwhile.
            await registerFresh(accountA, nextAddress());
            return { ...nextEvidence(), registeredAt };
          },
        };

        await expect(
          new ReconcileWalletRegistrationService(walletRepository, racing, () => changedAt).execute({
            accountId: accountA,
            txHash: nextEvidence().transactionHash,
            actorAccountId: staffAccount,
          }),
        ).rejects.toMatchObject({ code: "wallet.registration_changed", status: 409 });
        expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
          registeredAt: null,
          expiredAt: null,
        });
        expect(expired.walletAddress).not.toBe(
          (await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).walletAddress,
        );
      });

      it("still answers 404 for an account with no claim at all", async () => {
        await expect(
          reconcileService.execute({ accountId: accountB, txHash: verified.transactionHash, actorAccountId: staffAccount }),
        ).rejects.toMatchObject({ code: "wallet.account_not_found", status: 404 });
      });
    });
  });

  // The watcher counts a late registry event for an expired claim as UNMATCHED,
  // not as stale (AD-287, decided 2026-11-17). Real repository, fake chain, the
  // cursor kept in memory so the shared cursor row is not touched.
  describe("the watcher and a late event for an expired claim", () => {
    class InMemoryCursorRepository extends PrismaSettlementRepository {
      public cursor: bigint | null = null;
      public override async getLastProcessedWalletRegistryBlock(): Promise<bigint | null> {
        return this.cursor;
      }
      public override async setLastProcessedWalletRegistryBlock(block: bigint): Promise<void> {
        this.cursor = block;
      }
    }
    // The cursor sits at block 800 unless a test says otherwise, so the run reads
    // blocks 769 to 997 (the chain is at 1000, three blocks of depth, a 32-block
    // overlap) and an event in block 900 is news.
    const runWatcher = async (events: Array<{ blockNumber: bigint; wallet: string; commitment: string }>, cursor: bigint | null = 800n) => {
      const repository = new InMemoryCursorRepository(database);
      repository.cursor = cursor;
      const { chain } = makeFakeChain({ latestBlock: 1_000n, events });
      const watcher = new ConfirmWalletRegistrationsService(repository, chain as never, () => new Date(), 5 * 60_000);
      return watcher.execute();
    };

    it("counts it as unmatched and new, confirms nothing, and records no address mismatch", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      const summary = await runWatcher([{ blockNumber: 900n, wallet: expired.walletAddress, commitment: expired.registrationCommitment }]);

      expect(summary).toMatchObject({
        eventsFound: 1,
        registrationsConfirmed: 0,
        unmatchedEvents: 1,
        newUnmatchedEvents: 1,
        staleConfirmations: 0,
        addressMismatches: [],
      });
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        registeredAt: null,
        expiredAt: now,
      });
      expect(await auditRows(accountA, "confirmed")).toHaveLength(0);
    });

    it("counts an event from a different sender for an expired commitment as unmatched too, not as a spoofed registration", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      const summary = await runWatcher([{ blockNumber: 900n, wallet: nextAddress(), commitment: expired.registrationCommitment }]);

      expect(summary).toMatchObject({ unmatchedEvents: 1, newUnmatchedEvents: 1, addressMismatches: [] });
      expect(await database.auditLog.count({ where: { resourceId: accountA, action: "settlement.wallet_registration_address_mismatch" } })).toBe(0);
    });

    it("counts it as unmatched but not as new when a completed run has already read that block", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      const summary = await runWatcher(
        [{ blockNumber: 940n, wallet: expired.walletAddress, commitment: expired.registrationCommitment }],
        950n,
      );

      expect(summary).toMatchObject({ unmatchedEvents: 1, newUnmatchedEvents: 0 });
    });

    it("matches the same event to the live claim once the account has registered again with that commitment", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const renewed = await registerFresh(accountA, expired.walletAddress);

      const summary = await runWatcher([
        { blockNumber: 900n, wallet: expired.walletAddress, commitment: expired.registrationCommitment },
        { blockNumber: 901n, wallet: expired.walletAddress, commitment: renewed.registrationCommitment },
      ]);

      expect(summary).toMatchObject({ eventsFound: 2, registrationsConfirmed: 1, unmatchedEvents: 1, newUnmatchedEvents: 1 });
      expect(await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).toMatchObject({
        registrationCommitment: renewed.registrationCommitment,
      });
      expect((await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).registeredAt).not.toBeNull();
    });
  });

  // Every read agrees that an expired claim is no registration, and moves with
  // the claim afterwards: re-registered it is pending, reconciled it is registered.
  describe("the customer-side reads of an expired claim", () => {
    const profiles = new GetProfileService(
      new PrismaProfileRepository(
        database,
        { getEligibilitySnapshot: async () => null } as never,
        walletRepository,
        { getSummary: async () => ({ reservationCount: 0, activePositionCount: 0 }) } as never,
        { getPending: async () => null } as never,
      ),
      { get: async () => null },
    );
    const walletStatus = new GetWalletStatusService(walletRepository);
    const profileWallet = async (accountId: string) => {
      const { data } = await profiles.execute(accountId);
      return { wallet: data.wallet, readiness: data.readiness };
    };

    it("read as no wallet everywhere: the wallet status is 404, the profile says not_registered and not ready", async () => {
      await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });

      await expect(walletStatus.execute(accountA)).rejects.toMatchObject({ code: "wallet.not_registered", status: 404 });
      expect(await profileWallet(accountA)).toEqual({
        wallet: { status: "not_registered", requested_at: null, registered_at: null },
        readiness: { investment_eligible: false, payment_account_ready: false, payout_account_verified: false },
      });
    });

    it("read as pending again once the account has registered again, and as registered once staff reconcile the old claim instead", async () => {
      const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
      const renewed = await registerFresh(accountA, nextAddress());

      expect((await walletStatus.execute(accountA)).data).toMatchObject({ wallet_address: renewed.walletAddress, status: "pending" });
      expect((await profileWallet(accountA)).wallet.status).toBe("pending");
      expect((await profileWallet(accountA)).readiness).toMatchObject({ payment_account_ready: true, payout_account_verified: false });

      // The other account is reconciled instead, from the claim it held.
      const other = await createClaim(accountB, { requestedAt: longAgo, expiredAt: now });
      await walletRepository.reconcileWalletRegistration!({
        accountId: accountB,
        actorAccountId: staffAccount,
        expectedWalletAddress: other.walletAddress,
        expectedRegistrationCommitment: other.registrationCommitment,
        evidence: nextEvidence(),
        registeredAt: new Date("2026-11-17T10:00:00.000Z"),
        changedAt: new Date("2026-11-17T10:01:00.000Z"),
      });

      expect((await walletStatus.execute(accountB)).data).toMatchObject({ wallet_address: other.walletAddress, status: "registered" });
      expect(await profileWallet(accountB)).toMatchObject({
        wallet: { status: "registered" },
        readiness: { payment_account_ready: true, payout_account_verified: true },
      });
      expect(expired.walletAddress).not.toBe(renewed.walletAddress);
    });
  });

  // The register, confirm, reconcile and sweep writes all serialise on the
  // account's row (register and reconcile take it FOR UPDATE, the watcher's
  // confirm takes it through its UPDATE, the sweep takes it FOR UPDATE SKIP
  // LOCKED), the lock order of the claim lifecycle (#157). Whichever gets the
  // row first, the end state is one of the consistent ones below; none of these
  // can end with a confirmed row on an address nobody proved, or a row that is
  // confirmed and expired (the CHECK constraint forbids that outright).
  describe("concurrency on one claim", () => {
    const RACES = 12;
    const reset = async () => {
      await database.walletRegistration.deleteMany({ where: { accountId: accountA } });
      await database.auditLog.deleteMany({ where: { resourceId: accountA } });
    };
    const row = () => database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
    const reconcileCall = (claim: { walletAddress: string; registrationCommitment: string }, evidence = nextEvidence()) =>
      walletRepository.reconcileWalletRegistration!({
        accountId: accountA,
        actorAccountId: staffAccount,
        expectedWalletAddress: claim.walletAddress,
        expectedRegistrationCommitment: claim.registrationCommitment,
        evidence,
        registeredAt: new Date("2026-11-17T10:00:00.000Z"),
        changedAt: new Date("2026-11-17T10:01:00.000Z"),
      });

    it(`never loses a fresh registration to the sweep: over ${RACES} races the account ends pending on the new address, expired_at clear`, async () => {
      for (let race = 0; race < RACES; race += 1) {
        const stale = await createClaim(accountA, { requestedAt: longAgo });
        const address = nextAddress();

        const [swept, registered] = await Promise.all([sweep(), registerFresh(accountA, address)]);

        expect(swept.expired).toBeGreaterThanOrEqual(0);
        expect(await row()).toMatchObject({
          walletAddress: address,
          registrationCommitment: registered.registrationCommitment,
          registeredAt: null,
          expiredAt: null,
        });
        expect(registered.registrationCommitment).not.toBe(stale.registrationCommitment);
        const expiredAudits = (await auditRows(accountA, "expired")).length;
        expect(expiredAudits).toBeLessThanOrEqual(1);
        // The registration saw either the live claim (replaced) or the expired one (renewed), one audit row either way.
        expect((await auditRows(accountA, "replaced")).length + (await auditRows(accountA, "requested")).length).toBe(1);
        expect((await auditRows(accountA, expiredAudits === 1 ? "requested" : "replaced")).length).toBe(1);
        await reset();
      }
    });

    it(`never lets a stale session change the address through the sweep: over ${RACES} races the claim keeps its address and the registration is refused`, async () => {
      for (let race = 0; race < RACES; race += 1) {
        const stale = await createClaim(accountA, { requestedAt: longAgo });

        const [, refused] = await Promise.allSettled([sweep(), registerStale(accountA, nextAddress())]);

        expect(refused.status).toBe("rejected");
        expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
        expect(await row()).toMatchObject({
          walletAddress: stale.walletAddress,
          registrationCommitment: stale.registrationCommitment,
          registeredAt: null,
        });
        expect(await auditRows(accountA, "replaced")).toHaveLength(0);
        expect(await auditRows(accountA, "requested")).toHaveLength(0);
        await reset();
      }
    });

    it(`never both confirms and expires: over ${RACES} races the watcher's confirmation and the sweep leave a confirmed row, or an expired one that the event did not confirm`, async () => {
      const outcomes = new Set<string>();
      for (let race = 0; race < RACES; race += 1) {
        const claim = await createClaim(accountA, { requestedAt: longAgo });

        const [, confirmation] = await Promise.all([
          sweep(),
          settlementRepository.confirmWalletRegistration({
            accountId: accountA,
            walletAddress: claim.walletAddress,
            registrationCommitment: claim.registrationCommitment,
            registeredAt: new Date(),
            evidence: nextEvidence(),
          }),
        ]);

        outcomes.add(confirmation);
        const current = await row();
        if (confirmation === "confirmed") {
          expect(current.registeredAt).not.toBeNull();
          expect(current.expiredAt).toBeNull();
          expect(await auditRows(accountA, "expired")).toHaveLength(0);
          expect(await auditRows(accountA, "confirmed")).toHaveLength(1);
        } else {
          // The sweep got the row first: the late event is for an expired claim.
          expect(confirmation).toBe("expired");
          expect(current.registeredAt).toBeNull();
          expect(current.expiredAt).not.toBeNull();
          expect(await auditRows(accountA, "expired")).toHaveLength(1);
          expect(await auditRows(accountA, "confirmed")).toHaveLength(0);
        }
        await reset();
      }
      expect([...outcomes].every((outcome) => outcome === "confirmed" || outcome === "expired")).toBe(true);
    });

    it(`ends confirmed whichever of a staff reconcile and the sweep gets the row first: over ${RACES} races`, async () => {
      for (let race = 0; race < RACES; race += 1) {
        const claim = await createClaim(accountA, { requestedAt: longAgo });

        const [, reconciled] = await Promise.all([sweep(), reconcileCall(claim)]);

        expect(reconciled).toMatchObject({ kind: "reconciled", outcome: "confirmed" });
        expect(await row()).toMatchObject({ registeredAt: new Date("2026-11-17T10:00:00.000Z"), expiredAt: null });
        const audit = await auditRows(accountA, "reconciled");
        expect(audit).toHaveLength(1);
        const expiredAudits = await auditRows(accountA, "expired");
        // Reinstated exactly when the sweep ran first.
        expect(Object.hasOwn(audit[0]!.changes as object, "reinstated_from_expired_at")).toBe(expiredAudits.length === 1);
        await reset();
      }
    });

    it(`gives a staff reconcile and the customer registering again exactly one winner: over ${RACES} races`, async () => {
      for (let race = 0; race < RACES; race += 1) {
        const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
        const newAddress = nextAddress();

        const [reconciled, registered] = await Promise.allSettled([reconcileCall(expired), registerFresh(accountA, newAddress)]);

        const current = await row();
        if (reconciled.status === "fulfilled") {
          // Staff got the row first: the claim is confirmed on the address the chain showed.
          expect(registered.status).toBe("rejected");
          expect((registered as PromiseRejectedResult).reason).toMatchObject({ reason: "address_mismatch" });
          expect(current).toMatchObject({ walletAddress: expired.walletAddress, expiredAt: null });
          expect(current.registeredAt).not.toBeNull();
        } else {
          // The customer got it first: the evidence belongs to a dead commitment and confirms nothing.
          expect(reconciled.reason).toBeInstanceOf(WalletRegistrationChangedError);
          expect(registered.status).toBe("fulfilled");
          expect(current).toMatchObject({ walletAddress: newAddress, registeredAt: null, expiredAt: null, registrationTxHash: null });
        }
        await reset();
      }
    });

    it(`confirms an expired claim once when two staff reconciles race: over ${RACES} races one confirms and the other finds it done`, async () => {
      for (let race = 0; race < RACES; race += 1) {
        const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
        const evidence = nextEvidence();

        const results = await Promise.all([reconcileCall(expired, evidence), reconcileCall(expired, evidence)]);

        expect(results.map((result) => (result.kind === "reconciled" ? result.outcome : result.kind)).sort()).toEqual([
          "confirmed",
          "unchanged",
        ]);
        expect(await auditRows(accountA, "reconciled")).toHaveLength(1);
        await reset();
      }
    });

    it(`never lets the watcher confirm an expired claim, whatever a staff reconcile does: over ${RACES} races`, async () => {
      for (let race = 0; race < RACES; race += 1) {
        const expired = await createClaim(accountA, { requestedAt: longAgo, expiredAt: now });
        const evidence = nextEvidence();

        const [confirmation, reconciled] = await Promise.all([
          settlementRepository.confirmWalletRegistration({
            accountId: accountA,
            walletAddress: expired.walletAddress,
            registrationCommitment: expired.registrationCommitment,
            registeredAt: new Date(),
            evidence: nextEvidence(),
          }),
          reconcileCall(expired, evidence),
        ]);

        // "expired" when the watcher got the row first, "already_registered" when staff did.
        expect(["expired", "already_registered"]).toContain(confirmation);
        expect(reconciled).toMatchObject({ kind: "reconciled", outcome: "confirmed" });
        expect(await auditRows(accountA, "confirmed")).toHaveLength(0);
        expect(await row()).toMatchObject({ registrationTxHash: evidence.transactionHash, expiredAt: null });
        await reset();
      }
    });
  });
});
