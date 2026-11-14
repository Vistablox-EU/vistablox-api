import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { isUniqueViolation } from "../src/infrastructure/database/unique-violation.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import {
  WalletAddressConflictError,
  WalletRegistrationChangedError,
  WalletReplacementFreshAuthenticationRequiredError,
} from "../src/modules/wallet/repository/wallet.repository.js";
import { buildWalletFreshAuthApp } from "./support/wallet-fresh-auth-app.js";

// Wallet claim lifecycle (#146): a pending claim is an account-scoped intent
// that never blocks another account; an address is bound exclusively only once
// it is confirmed, and the database enforces that through the partial unique
// index wallet_registrations_confirmed_address_key.
//
// Every address, commitment and account id is derived from a per-run suffix
// and is lowercase, and every test but three writes only lowercase addresses
// (the repository canonicalises what it is given). Those three tests insert a
// mixed-case row directly, to stand in for a row written before the canonical
// form; that is impossible once the wallet_registrations_wallet_address_
// lowercase_check constraint exists (the canonical-form change, #147), and the
// case they cover cannot occur then either. They detect the constraint and
// report as skipped rather than fail or pass vacuously.
const LOWERCASE_CHECK = "wallet_registrations_wallet_address_lowercase_check";
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("wallet claim lifecycle PostgreSQL integration", () => {
  const suffix = randomUUID();
  const hex = suffix.replaceAll("-", "");
  const accountIds = Array.from({ length: 4 }, (_, index) => `acct_claim${index}_${suffix}`);
  const betterAuthUserIds = accountIds.map((_, index) => `auth_claim${index}_${suffix}`);
  const accountA = accountIds[0]!;
  const accountB = accountIds[1]!;
  const accountC = accountIds[2]!;
  const staffAccount = accountIds[3]!;

  let addressCounter = 0;
  const nextAddress = (): string => `0x${hex}${(addressCounter++).toString(16).padStart(8, "0")}`;
  let commitmentCounter = 0;
  const nextCommitment = (): string => `0x${hex}${(commitmentCounter++).toString(16).padStart(32, "0")}`;
  const nextTxHash = (): string => `0x${hex}${(commitmentCounter++).toString(16).padStart(32, "f")}`;

  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const walletRepository = new PrismaWalletRepository(database);
  const settlementRepository = new PrismaSettlementRepository(database);

  // Most of this file is about the claim lifecycle, not about who may drive
  // it, so `register` models a session that passed the fresh-authentication
  // probe. The tests that are about freshness say so with `registerStale`.
  const register = (
    accountId: string,
    walletAddress: string,
    registrationCommitment = nextCommitment(),
    freshAuthentication = true,
  ) =>
    walletRepository.registerWallet({
      accountId,
      walletAddress,
      registrationCommitment,
      requestedAt: new Date(),
      freshAuthentication,
    });
  const registerStale = (accountId: string, walletAddress: string, registrationCommitment = nextCommitment()) =>
    register(accountId, walletAddress, registrationCommitment, false);

  // The identity of the confirming event: a distinct transaction per call, so
  // confirmations in one test never meet the one-event-one-registration index.
  const nextEvidence = () => ({
    transactionHash: nextTxHash(),
    blockHash: nextTxHash(),
    blockNumber: 12n,
    logIndex: 0,
  });

  const confirm = (accountId: string, walletAddress: string, registrationCommitment: string) =>
    settlementRepository.confirmWalletRegistration({
      accountId,
      walletAddress,
      registrationCommitment,
      registeredAt: new Date(),
      evidence: nextEvidence(),
    });

  // True when the database refuses a wallet_address that is not already
  // lowercase, so a legacy mixed-case row cannot be inserted.
  let lowercaseCheckPresent = false;
  const skipWithoutMixedCaseRows = (context: TestContext): void => {
    if (lowercaseCheckPresent) {
      context.skip(`${LOWERCASE_CHECK} is present: a mixed-case wallet_address cannot be stored`);
    }
  };

  const auditRows = (resourceId: string, action: string) =>
    database.auditLog.findMany({
      where: { resourceId, action: `settlement.wallet_registration_${action}` },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    for (const [index, accountId] of accountIds.entries()) {
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserIds[index], `Claim Test ${index}`, `claim-${index}-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId: betterAuthUserIds[index]! } });
    }
    const { rows } = await authPool.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid = 'settlement.wallet_registrations'::regclass AND conname = $1",
      [LOWERCASE_CHECK],
    );
    lowercaseCheckPresent = rows.length > 0;
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

  describe("the database model", () => {
    it("holds the address uniquely only among confirmed rows, through a partial unique index on lower(wallet_address)", async () => {
      const { rows } = await authPool.query<{ indexname: string; indexdef: string }>(
        "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'settlement' AND tablename = 'wallet_registrations'",
      );
      const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

      expect(byName.has("wallet_registrations_wallet_address_key")).toBe(false);
      const confirmed = byName.get("wallet_registrations_confirmed_address_key");
      expect(confirmed).toMatch(/CREATE UNIQUE INDEX/);
      expect(confirmed).toMatch(/lower\(wallet_address\)/);
      expect(confirmed).toMatch(/WHERE \(registered_at IS NOT NULL\)/);
    });

    it("lets two accounts hold a pending claim on the same address, however it is cased, without error", async () => {
      const address = nextAddress();

      const first = await register(accountA, address);
      const second = await register(accountB, address.toUpperCase().replace("0X", "0x"));

      expect(first.walletAddress).toBe(address);
      expect(second.walletAddress).toBe(address);
      expect(first.registrationCommitment).not.toBe(second.registrationCommitment);
      expect(await database.walletRegistration.count({ where: { walletAddress: address } })).toBe(2);
    });

    it("rejects a second confirmed row for an address in any case, at the database", async (context) => {
      skipWithoutMixedCaseRows(context);
      const address = nextAddress();
      await database.walletRegistration.create({
        data: { accountId: accountA, walletAddress: address, registrationCommitment: nextCommitment(), registeredAt: new Date() },
      });
      await database.walletRegistration.create({
        data: { accountId: accountB, walletAddress: address.toUpperCase().replace("0X", "0x"), registrationCommitment: nextCommitment() },
      });

      await expect(
        database.walletRegistration.update({ where: { accountId: accountB }, data: { registeredAt: new Date() } }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  it("reports the same violation as a unique violation of the index, from a typed call and from a raw statement", async () => {
    const address = nextAddress();
    await database.walletRegistration.create({
      data: { accountId: accountA, walletAddress: address, registrationCommitment: nextCommitment(), registeredAt: new Date() },
    });
    await database.walletRegistration.create({
      data: { accountId: accountB, walletAddress: address, registrationCommitment: nextCommitment() },
    });

    const typed = await database.walletRegistration
      .updateMany({ where: { accountId: accountB }, data: { registeredAt: new Date() } })
      .catch((error: unknown) => error);
    const raw = await database
      .$executeRaw`UPDATE settlement.wallet_registrations SET registered_at = now() WHERE account_id = ${accountB}`
      .catch((error: unknown) => error);

    expect(isUniqueViolation(typed, "wallet_registrations_confirmed_address_key")).toBe(true);
    expect(isUniqueViolation(raw, "wallet_registrations_confirmed_address_key")).toBe(true);
    expect(isUniqueViolation(typed, "wallet_registrations_pkey")).toBe(false);
    expect(isUniqueViolation(raw, "wallet_registrations_pkey")).toBe(false);
  });

  describe("registerWallet", () => {
    it("does not let a pending claim block another account from registering and confirming the address", async () => {
      const address = nextAddress();
      const squatter = await register(accountA, address);
      const owner = await register(accountB, address);

      const outcome = await confirm(accountB, address, owner.registrationCommitment);

      expect(outcome).toBe("confirmed");
      expect(squatter.registeredAt).toBeNull();
      await expect(register(accountA, address)).rejects.toMatchObject({ reason: "address_claimed" });
    });

    it("rejects an address confirmed for another account, in any case, including a replay of an earlier pending claim", async () => {
      const address = nextAddress();
      const pending = await register(accountB, address);
      const owner = await register(accountA, address);
      await confirm(accountA, address, owner.registrationCommitment);

      await expect(register(accountC, address.toUpperCase().replace("0X", "0x"))).rejects.toBeInstanceOf(WalletAddressConflictError);
      // B's own earlier claim is dead: its replay must not hand the commitment out again.
      await expect(register(accountB, address)).rejects.toMatchObject({ reason: "address_claimed" });
      expect(pending.registeredAt).toBeNull();

      // B can still replace the dead claim with an address of its own.
      const own = nextAddress();
      await expect(register(accountB, own)).resolves.toMatchObject({ walletAddress: own, registeredAt: null });
    });

    it("does not let a pending claim be replaced onto an address another account has confirmed, and leaves the claim as it was", async () => {
      const own = nextAddress();
      const elsewhere = nextAddress();
      const pending = await register(accountB, own);
      const owner = await register(accountA, elsewhere);
      await confirm(accountA, elsewhere, owner.registrationCommitment);

      await expect(register(accountB, elsewhere)).rejects.toMatchObject({ reason: "address_claimed" });
      await expect(register(accountB, elsewhere.toUpperCase().replace("0X", "0x"))).rejects.toMatchObject({
        reason: "address_claimed",
      });

      // The refused replace wrote nothing: same address, same commitment, still
      // pending, still matchable by the event watcher, and no `replaced` audit row.
      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountB } });
      expect(row).toMatchObject({
        walletAddress: own,
        registrationCommitment: pending.registrationCommitment,
        requestedAt: pending.requestedAt,
        registeredAt: null,
      });
      expect(await settlementRepository.findWalletRegistrationByCommitment(pending.registrationCommitment)).toMatchObject({
        accountId: accountB,
        walletAddress: own,
      });
      expect(await auditRows(accountB, "replaced")).toHaveLength(0);
    });

    it("replays a confirmed registration, and rejects a different address as a mismatch (or as claimed when that address is confirmed elsewhere)", async () => {
      const address = nextAddress();
      const created = await register(accountA, address);
      await confirm(accountA, address, created.registrationCommitment);

      const replay = await register(accountA, address, nextCommitment());
      expect(replay).toMatchObject({ walletAddress: address, registrationCommitment: created.registrationCommitment });
      expect(replay.registeredAt).not.toBeNull();

      await expect(register(accountA, nextAddress())).rejects.toMatchObject({ reason: "address_mismatch" });

      const elsewhere = nextAddress();
      const other = await register(accountB, elsewhere);
      await confirm(accountB, elsewhere, other.registrationCommitment);
      await expect(register(accountA, elsewhere)).rejects.toMatchObject({ reason: "address_claimed" });
    });

    it("replaces a pending claim in place: new address, new commitment, new requested_at, one audit row, old commitment dead", async () => {
      const x = nextAddress();
      const y = nextAddress();
      const c1 = nextCommitment();
      const c2 = nextCommitment();
      const t1 = new Date("2026-11-01T10:00:00.000Z");
      const t2 = new Date("2026-11-01T11:00:00.000Z");

      await walletRepository.registerWallet({ accountId: accountA, walletAddress: x, registrationCommitment: c1, requestedAt: t1, freshAuthentication: true });
      const replaced = await walletRepository.registerWallet({ accountId: accountA, walletAddress: y, registrationCommitment: c2, requestedAt: t2, freshAuthentication: true });

      expect(replaced).toMatchObject({ walletAddress: y, registrationCommitment: c2, requestedAt: t2, registeredAt: null });
      expect(await database.walletRegistration.count({ where: { accountId: accountA } })).toBe(1);
      expect(await settlementRepository.findWalletRegistrationByCommitment(c1)).toBeNull();
      expect(await settlementRepository.findWalletRegistrationByCommitment(c2)).toMatchObject({
        accountId: accountA,
        walletAddress: y,
        registrationCommitment: c2,
      });

      const replacedAudit = await auditRows(accountA, "replaced");
      expect(replacedAudit).toHaveLength(1);
      expect(replacedAudit[0]).toMatchObject({
        actorAccountId: accountA,
        resourceType: "account",
        changes: { previous_wallet_address: x, wallet_address: y },
      });
      // A commitment is never copied into an audit row.
      expect(JSON.stringify(replacedAudit[0]!.changes)).not.toContain(c1);
      expect(JSON.stringify(replacedAudit[0]!.changes)).not.toContain(c2);

      // Replaying the new claim keeps its commitment rather than minting another.
      const replay = await walletRepository.registerWallet({
        accountId: accountA,
        walletAddress: y,
        registrationCommitment: nextCommitment(),
        requestedAt: new Date("2026-11-01T12:00:00.000Z"),
        freshAuthentication: false,
      });
      expect(replay).toMatchObject({ registrationCommitment: c2, requestedAt: t2 });
      expect(await auditRows(accountA, "replaced")).toHaveLength(1);
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
    });

    it("stores the address trimmed and lowercase, whatever the caller passed", async () => {
      const address = nextAddress();
      const messy = ` 0x${address.slice(2).toUpperCase()} `;

      const created = await register(accountA, messy);

      expect(created.walletAddress).toBe(address);
      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
      expect(row.walletAddress).toBe(address);
      expect((await auditRows(accountA, "requested"))[0]!.changes).toEqual({ wallet_address: address });
    });

    it("treats a legacy mixed-case row as the same address: replay, block and resolve case-insensitively", async (context) => {
      skipWithoutMixedCaseRows(context);
      const address = nextAddress();
      const legacy = `0x${address.slice(2).toUpperCase()}`;
      const commitment = nextCommitment();
      await database.walletRegistration.create({
        data: { accountId: accountA, walletAddress: legacy, registrationCommitment: commitment, registeredAt: new Date() },
      });

      await expect(register(accountA, address)).resolves.toMatchObject({ walletAddress: legacy, registrationCommitment: commitment });
      await expect(register(accountB, address)).rejects.toMatchObject({ reason: "address_claimed" });
      await expect(settlementRepository.resolveAccountIdForWallet(address)).resolves.toBe(accountA);
      await expect(settlementRepository.resolveAccountIdForWallet(legacy)).resolves.toBe(accountA);
    });

    it("survives 8 parallel identical registrations: no rejection, one row, one requested audit row", async () => {
      const address = nextAddress();

      const results = await Promise.allSettled(Array.from({ length: 8 }, () => register(accountA, address)));

      expect(results.map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
      const commitments = new Set(
        results.map((result) => (result as PromiseFulfilledResult<{ registrationCommitment: string }>).value.registrationCommitment),
      );
      expect(commitments.size).toBe(1);
      expect(await database.walletRegistration.count({ where: { accountId: accountA } })).toBe(1);
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
    });

    it("survives 8 parallel registrations over 4 addresses: no rejection, one row whose address and commitment belong to one request", async () => {
      const addresses = Array.from({ length: 4 }, () => nextAddress());
      const requests = Array.from({ length: 8 }, (_, index) => ({
        walletAddress: addresses[index % 4]!,
        registrationCommitment: nextCommitment(),
      }));

      const results = await Promise.allSettled(requests.map((request) => register(accountA, request.walletAddress, request.registrationCommitment)));

      expect(results.map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
      expect(requests).toContainEqual({ walletAddress: row.walletAddress, registrationCommitment: row.registrationCommitment });
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
      expect((await auditRows(accountA, "replaced")).length).toBeLessThanOrEqual(7);
    });
  });

  // A customer who replaces their own still-pending claim with a different
  // address must have confirmed who is holding the device recently (founder
  // decision of 2026-11-14 on conflict C-010, question 2: ON_CHAIN_SETTLEMENT.md
  // step 10 asks for fresh authentication on any address replacement). The
  // decision is taken inside the row-locked transaction, so a concurrent
  // request cannot slip between "is it a replacement?" and the write.
  describe("replacing a pending claim needs fresh authentication", () => {
    const upper = (address: string) => `0x${address.slice(2).toUpperCase()}`;

    const snapshot = async (accountId: string) => {
      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId } });
      return {
        walletAddress: row.walletAddress,
        registrationCommitment: row.registrationCommitment,
        requestedAt: row.requestedAt,
        registeredAt: row.registeredAt,
        registrationTxHash: row.registrationTxHash,
      };
    };

    it("refuses a stale replacement with the typed error and writes nothing: row, commitment, requested_at and audit trail all unchanged", async () => {
      const x = nextAddress();
      const y = nextAddress();
      const first = await register(accountA, x);
      const before = await snapshot(accountA);
      const refusedCommitment = nextCommitment();

      await expect(registerStale(accountA, y, refusedCommitment)).rejects.toBeInstanceOf(
        WalletReplacementFreshAuthenticationRequiredError,
      );

      expect(await snapshot(accountA)).toEqual(before);
      expect(before).toMatchObject({ walletAddress: x, registrationCommitment: first.registrationCommitment, registeredAt: null });
      // The old commitment still matches for the event watcher; the refused one was never stored.
      expect(await settlementRepository.findPendingWalletRegistrationByCommitment(first.registrationCommitment)).toMatchObject({
        accountId: accountA,
        walletAddress: x,
      });
      expect(await settlementRepository.findPendingWalletRegistrationByCommitment(refusedCommitment)).toBeNull();
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
      expect(
        await database.auditLog.count({ where: { resourceId: accountA, action: { startsWith: "settlement.wallet_registration_" } } }),
      ).toBe(1);
    });

    it("carries nothing about the claim in the refusal: no address, no account id, no commitment", async () => {
      const x = nextAddress();
      const y = nextAddress();
      await register(accountA, x);

      const error = await registerStale(accountA, y).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const secret of [x, y, accountA]) expect(text).not.toContain(secret);
    });

    it("replaces the claim when the session is fresh: new address, new commitment, new requested_at, one audit row", async () => {
      const x = nextAddress();
      const y = nextAddress();
      const c2 = nextCommitment();
      const t2 = new Date("2026-11-01T11:00:00.000Z");
      await walletRepository.registerWallet({
        accountId: accountA,
        walletAddress: x,
        registrationCommitment: nextCommitment(),
        requestedAt: new Date("2026-11-01T10:00:00.000Z"),
        freshAuthentication: false,
      });

      const replaced = await walletRepository.registerWallet({
        accountId: accountA,
        walletAddress: y,
        registrationCommitment: c2,
        requestedAt: t2,
        freshAuthentication: true,
      });

      expect(replaced).toMatchObject({ walletAddress: y, registrationCommitment: c2, requestedAt: t2, registeredAt: null });
      const replacedAudit = await auditRows(accountA, "replaced");
      expect(replacedAudit).toHaveLength(1);
      expect(replacedAudit[0]).toMatchObject({ changes: { previous_wallet_address: x, wallet_address: y } });
    });

    it("lets a stale session register the first address: no row yet means no replacement", async () => {
      const address = nextAddress();

      const created = await registerStale(accountA, address);

      expect(created).toMatchObject({ walletAddress: address, registeredAt: null });
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
    });

    it("lets a stale session replay the same address, in any hex case and with surrounding whitespace, and writes nothing", async () => {
      const address = nextAddress();
      const created = await registerStale(accountA, address);
      const before = await snapshot(accountA);

      for (const variant of [address, upper(address), ` ${address} `, `\t${upper(address)}\n`]) {
        const replay = await registerStale(accountA, variant, nextCommitment());
        expect(replay).toMatchObject({
          walletAddress: address,
          registrationCommitment: created.registrationCommitment,
          requestedAt: created.requestedAt,
          registeredAt: null,
        });
      }

      expect(await snapshot(accountA)).toEqual(before);
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
    });

    it("treats a legacy mixed-case pending row as the same address for a stale replay, not as a replacement", async (context) => {
      skipWithoutMixedCaseRows(context);
      const address = nextAddress();
      const legacy = upper(address);
      const commitment = nextCommitment();
      await database.walletRegistration.create({
        data: { accountId: accountA, walletAddress: legacy, registrationCommitment: commitment },
      });

      await expect(registerStale(accountA, address)).resolves.toMatchObject({
        walletAddress: legacy,
        registrationCommitment: commitment,
      });
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
    });

    it("leaves a confirmed registration's outcomes unchanged whether the session is fresh or stale", async () => {
      const address = nextAddress();
      const created = await register(accountA, address);
      await confirm(accountA, address, created.registrationCommitment);
      const elsewhere = nextAddress();
      const other = await register(accountB, elsewhere);
      await confirm(accountB, elsewhere, other.registrationCommitment);

      for (const attempt of [register, registerStale]) {
        await expect(attempt(accountA, nextAddress())).rejects.toMatchObject({ reason: "address_mismatch" });
        await expect(attempt(accountA, elsewhere)).rejects.toMatchObject({ reason: "address_claimed" });
        await expect(attempt(accountA, upper(address))).resolves.toMatchObject({
          walletAddress: address,
          registrationCommitment: created.registrationCommitment,
        });
      }
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
    });

    it("asks for fresh authentication before it says an address is confirmed elsewhere: a stale session learns nothing about other accounts", async () => {
      const own = nextAddress();
      const elsewhere = nextAddress();
      const pending = await register(accountB, own);
      const owner = await register(accountA, elsewhere);
      await confirm(accountA, elsewhere, owner.registrationCommitment);

      // Stale: the same refusal as for an address nobody holds, so it cannot tell the two apart.
      const stale = await registerStale(accountB, elsewhere).catch((caught: unknown) => caught);
      const staleFree = await registerStale(accountB, nextAddress()).catch((caught: unknown) => caught);
      expect(stale).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      expect(staleFree).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      expect((stale as Error).message).toBe((staleFree as Error).message);
      // Fresh: now it may be told.
      await expect(register(accountB, elsewhere)).rejects.toMatchObject({ reason: "address_claimed" });

      expect(await snapshot(accountB)).toMatchObject({ walletAddress: own, registrationCommitment: pending.registrationCommitment });
      expect(await auditRows(accountB, "replaced")).toHaveLength(0);
    });

    it("still reports address_claimed to a stale replay of an own pending address that another account has since confirmed", async () => {
      const address = nextAddress();
      await register(accountB, address);
      const owner = await register(accountA, address);
      await confirm(accountA, address, owner.registrationCommitment);

      await expect(registerStale(accountB, address)).rejects.toMatchObject({ reason: "address_claimed" });
      await expect(registerStale(accountB, upper(address))).rejects.toMatchObject({ reason: "address_claimed" });
    });

    it("refuses every one of 8 parallel stale replacements over 4 addresses, and the row stays exactly as it was", async () => {
      const first = await register(accountA, nextAddress());
      const before = await snapshot(accountA);
      const addresses = Array.from({ length: 4 }, () => nextAddress());

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) => registerStale(accountA, addresses[index % 4]!)),
      );

      for (const result of results) {
        expect(result).toMatchObject({ status: "rejected" });
        expect((result as PromiseRejectedResult).reason).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      }
      expect(await snapshot(accountA)).toEqual(before);
      expect(before.registrationCommitment).toBe(first.registrationCommitment);
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
    });

    it("leaves one consistent row when 8 fresh replacements over 4 addresses run in parallel", async () => {
      await register(accountA, nextAddress());
      const addresses = Array.from({ length: 4 }, () => nextAddress());
      const requests = Array.from({ length: 8 }, (_, index) => ({
        walletAddress: addresses[index % 4]!,
        registrationCommitment: nextCommitment(),
      }));

      const results = await Promise.allSettled(
        requests.map((entry) => register(accountA, entry.walletAddress, entry.registrationCommitment, true)),
      );

      expect(results.map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
      const row = await snapshot(accountA);
      expect(requests).toContainEqual({ walletAddress: row.walletAddress, registrationCommitment: row.registrationCommitment });
      expect(row.registeredAt).toBeNull();
      expect(await database.walletRegistration.count({ where: { accountId: accountA } })).toBe(1);
      const replaced = await auditRows(accountA, "replaced");
      expect(replaced.length).toBeGreaterThanOrEqual(1);
      expect(replaced.length).toBeLessThanOrEqual(8);
      for (const entry of replaced) {
        expect(addresses).toContain((entry.changes as { wallet_address: string }).wallet_address);
      }
    });

    it("never lets a stale request win against a fresh one: with 1 fresh and 3 stale replacements in parallel the fresh address stands", async () => {
      for (let round = 0; round < 5; round += 1) {
        await register(accountA, nextAddress());
        const freshAddress = nextAddress();
        const staleAddresses = Array.from({ length: 3 }, () => nextAddress());

        const results = await Promise.allSettled([
          ...staleAddresses.map((address) => registerStale(accountA, address)),
          register(accountA, freshAddress, nextCommitment(), true),
        ]);

        expect(results.slice(0, 3).every((result) => result.status === "rejected")).toBe(true);
        expect(results[3]).toMatchObject({ status: "fulfilled" });
        const row = await snapshot(accountA);
        expect(row.walletAddress).toBe(freshAddress);
        const replacedAddresses = (await auditRows(accountA, "replaced")).map(
          (entry) => (entry.changes as { wallet_address: string }).wallet_address,
        );
        for (const address of staleAddresses) expect(replacedAddresses).not.toContain(address);
        await database.walletRegistration.deleteMany({ where: { accountId: accountA } });
        await database.auditLog.deleteMany({ where: { resourceId: accountA } });
      }
    });

    it("lets exactly one of 4 concurrent stale first registrations with different addresses through: the losers would be replacements", async () => {
      const addresses = Array.from({ length: 4 }, () => nextAddress());

      const results = await Promise.allSettled(addresses.map((address) => registerStale(accountA, address)));

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(3);
      for (const result of rejected) expect(result.reason).toBeInstanceOf(WalletReplacementFreshAuthenticationRequiredError);
      const row = await snapshot(accountA);
      const winner = (fulfilled[0] as PromiseFulfilledResult<{ walletAddress: string }>).value.walletAddress;
      expect(row.walletAddress).toBe(winner);
      expect(addresses).toContain(winner);
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
    });

    it("lets all of 8 concurrent stale first registrations of the SAME address through: a replay is not a replacement", async () => {
      const address = nextAddress();

      const results = await Promise.allSettled(Array.from({ length: 8 }, () => registerStale(accountA, address)));

      expect(results.map((result) => result.status)).toEqual(Array(8).fill("fulfilled"));
      expect(await auditRows(accountA, "requested")).toHaveLength(1);
      expect(await auditRows(accountA, "replaced")).toHaveLength(0);
    });

    it("never lets a stale replacement overtake the watcher's confirmation: over 12 races the row stays on the original address, whichever request takes the row lock first", async () => {
      for (let round = 0; round < 12; round += 1) {
        const x = nextAddress();
        const y = nextAddress();
        const old = await register(accountA, x);
        const refusedCommitment = nextCommitment();

        // Alternate which request is started first, so both orders of the row
        // lock are exercised: the replacement first (it must be refused, and
        // the confirmation then still matches the original claim) and the
        // confirmation first (the claim is confirmed, and the replacement runs
        // into a confirmed row).
        let replacementCall: ReturnType<typeof registerStale>;
        let confirmationCall: ReturnType<typeof confirm>;
        if (round % 2 === 0) {
          replacementCall = registerStale(accountA, y, refusedCommitment);
          confirmationCall = confirm(accountA, x, old.registrationCommitment);
        } else {
          confirmationCall = confirm(accountA, x, old.registrationCommitment);
          replacementCall = registerStale(accountA, y, refusedCommitment);
        }
        const [replacement, confirmed] = await Promise.allSettled([replacementCall, confirmationCall]);

        // A stale replacement never succeeds, whoever wins the race.
        expect(replacement.status).toBe("rejected");
        const reason = (replacement as PromiseRejectedResult).reason as unknown;
        expect(
          reason instanceof WalletReplacementFreshAuthenticationRequiredError ||
            (reason instanceof WalletAddressConflictError && reason.reason === "address_mismatch"),
        ).toBe(true);

        // The row never ends on the refused address, whatever the confirmation did.
        const row = await snapshot(accountA);
        expect(row.walletAddress).toBe(x);
        expect(row.registrationCommitment).toBe(old.registrationCommitment);
        expect(await settlementRepository.findPendingWalletRegistrationByCommitment(refusedCommitment)).toBeNull();
        expect(await auditRows(accountA, "replaced")).toHaveLength(0);

        // Original pending claim (the confirmation reported stale) or confirmed
        // on the original address (it reported confirmed); never a mix.
        expect(confirmed.status).toBe("fulfilled");
        const outcome = (confirmed as PromiseFulfilledResult<{ outcome: string }>).value.outcome;
        if (outcome === "confirmed") {
          expect(row.registeredAt).not.toBeNull();
          expect(await auditRows(accountA, "confirmed")).toHaveLength(1);
        } else {
          expect(outcome).toBe("stale");
          expect(row.registeredAt).toBeNull();
          expect(await auditRows(accountA, "confirmed")).toHaveLength(0);
        }
        await database.walletRegistration.deleteMany({ where: { accountId: accountA } });
        await database.auditLog.deleteMany({ where: { resourceId: accountA } });
      }
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

      it("answers a stale session's replacement with the 403 envelope and leaves rows and audit unchanged; the same request on a fresh session is a 201", async () => {
        const x = nextAddress();
        const y = nextAddress();
        expect((await post(app(accountA, 10 * 60_000), x)).status).toBe(201);
        const before = await snapshot(accountA);

        const refused = await post(app(accountA, 10 * 60_000), y);

        expect(refused.status).toBe(403);
        expect(Object.keys(refused.body).sort()).toEqual(["code", "detail", "status", "title", "trace_id", "type"]);
        expect(refused.body).toMatchObject({
          type: "https://api.vistablox.io/errors/authentication.fresh_auth_required",
          code: "authentication.fresh_auth_required",
          title: "Fresh authentication required",
          status: 403,
          detail: "Sign in again on this device before continuing.",
        });
        expect(typeof refused.body.trace_id).toBe("string");
        expect(refused.body.trace_id.length).toBeGreaterThan(0);
        expect(await snapshot(accountA)).toEqual(before);
        expect(await auditRows(accountA, "replaced")).toHaveLength(0);

        // The client signs in again on the device and repeats the same POST.
        const retried = await post(app(accountA, 30_000), y);

        expect(retried.status).toBe(201);
        expect(retried.body.data).toMatchObject({ wallet_address: y, status: "pending" });
        expect(retried.body.data.registration_commitment).not.toBe(before.registrationCommitment);
        expect(await auditRows(accountA, "replaced")).toHaveLength(1);
      });

      it("serves a stale session's first registration and replay (in another case) as 201, with the same commitment", async () => {
        const address = nextAddress();

        const first = await post(app(accountA, 10 * 60_000), address);
        const replay = await post(app(accountA, 10 * 60_000), upper(address));

        expect(first.status).toBe(201);
        expect(replay.status).toBe(201);
        expect(replay.body.data.registration_commitment).toBe(first.body.data.registration_commitment);
        expect(replay.body.data.requested_at).toBe(first.body.data.requested_at);
        expect(await auditRows(accountA, "requested")).toHaveLength(1);
      });

      it("keeps a confirmed account's 409 a 409 on a stale session", async () => {
        const address = nextAddress();
        const created = await register(accountA, address);
        await confirm(accountA, address, created.registrationCommitment);

        const response = await post(app(accountA, 10 * 60_000), nextAddress());

        expect(response.status).toBe(409);
        expect(response.body.code).toBe("wallet.registration_address_mismatch");
      });
    });
  });

  describe("confirmWalletRegistration", () => {
    it("confirms the matched claim once, writes one confirmed audit row, and reports a repeat as already registered", async () => {
      const address = nextAddress();
      const claim = await register(accountA, address);

      await expect(confirm(accountA, address, claim.registrationCommitment)).resolves.toBe("confirmed");
      await expect(confirm(accountA, address, claim.registrationCommitment)).resolves.toBe("already_registered");

      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
      expect(row.registeredAt).not.toBeNull();
      const confirmed = await auditRows(accountA, "confirmed");
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]).toMatchObject({
        actorAccountId: null,
        resourceType: "wallet_registration",
        changes: { wallet_address: address, registered_at: row.registeredAt!.toISOString() },
      });
    });

    it("does not confirm a claim that was replaced after it was matched", async () => {
      const x = nextAddress();
      const y = nextAddress();
      const first = await register(accountA, x);
      const second = await register(accountA, y);

      await expect(confirm(accountA, x, first.registrationCommitment)).resolves.toBe("stale");

      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
      expect(row).toMatchObject({ walletAddress: y, registrationCommitment: second.registrationCommitment, registeredAt: null });
      expect(await auditRows(accountA, "confirmed")).toHaveLength(0);
    });

    it("compares the stored address and commitment exactly, not case-insensitively", async () => {
      const address = nextAddress();
      const claim = await register(accountA, address);

      await expect(confirm(accountA, address, claim.registrationCommitment.toUpperCase().replace("0X", "0x"))).resolves.toBe(
        "stale",
      );
      await expect(confirm(accountB, address, claim.registrationCommitment)).resolves.toBe("stale");
      expect((await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).registeredAt).toBeNull();
    });

    it("lets exactly one of two accounts win a concurrent confirmation of one address, and audits the loser once however often it retries", async () => {
      const address = nextAddress();
      const a = await register(accountA, address);
      const b = await register(accountB, address);

      const outcomes = await Promise.all([
        confirm(accountA, address, a.registrationCommitment),
        confirm(accountB, address, b.registrationCommitment),
      ]);

      expect([...outcomes].sort()).toEqual(["address_conflict", "confirmed"]);
      expect(
        await database.walletRegistration.count({ where: { walletAddress: address, registeredAt: { not: null } } }),
      ).toBe(1);

      const [loserId, loserCommitment, winnerId] =
        outcomes[0] === "address_conflict"
          ? [accountA, a.registrationCommitment, accountB]
          : [accountB, b.registrationCommitment, accountA];
      // The watcher rescans an overlapping range: the same event comes round again.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(confirm(loserId, address, loserCommitment)).resolves.toBe("address_conflict");
      }

      const conflicts = await auditRows(loserId, "confirmation_conflict");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        actorAccountId: null,
        resourceType: "wallet_registration",
        changes: { wallet_address: address, holder_account_id: winnerId, source: "chain_event" },
      });
      expect(await auditRows(winnerId, "confirmation_conflict")).toHaveLength(0);
      // The losing claim stays pending, and its next register call says why.
      expect((await database.walletRegistration.findUniqueOrThrow({ where: { accountId: loserId } })).registeredAt).toBeNull();
      await expect(register(loserId, address)).rejects.toMatchObject({ reason: "address_claimed" });
    });

    it("never confirms the replaced address on the old address's evidence, over 20 confirm-versus-replace races", async () => {
      for (let round = 0; round < 20; round += 1) {
        const x = nextAddress();
        const y = nextAddress();
        const old = await register(accountA, x);
        const newCommitment = nextCommitment();

        const [confirmation, replacement] = await Promise.allSettled([
          confirm(accountA, x, old.registrationCommitment),
          register(accountA, y, newCommitment),
        ]);

        const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
        if (confirmation.status === "fulfilled" && confirmation.value === "confirmed") {
          // The confirmation won: the registration is bound to X and the replacement was refused.
          expect(replacement).toMatchObject({ status: "rejected", reason: { reason: "address_mismatch" } });
          expect(row).toMatchObject({ walletAddress: x, registrationCommitment: old.registrationCommitment });
          expect(row.registeredAt).not.toBeNull();
        } else {
          // The replacement won: the confirmation was stale and nothing about Y was confirmed.
          expect(confirmation).toMatchObject({ status: "fulfilled", value: "stale" });
          expect(replacement.status).toBe("fulfilled");
          expect(row).toMatchObject({ walletAddress: y, registrationCommitment: newCommitment, registeredAt: null });
        }
        await database.walletRegistration.deleteMany({ where: { accountId: accountA } });
      }
    });

    it("reports a conflict, and audits it, for a pending claim that slipped in after another account confirmed the address", async () => {
      const address = nextAddress();
      const owner = await register(accountA, address);
      await confirm(accountA, address, owner.registrationCommitment);
      await expect(register(accountB, address)).rejects.toMatchObject({ reason: "address_claimed" });

      // The benign race window: B's register passed its check just before A confirmed.
      const lateCommitment = nextCommitment();
      await database.walletRegistration.create({
        data: { accountId: accountB, walletAddress: address, registrationCommitment: lateCommitment },
      });

      await expect(confirm(accountB, address, lateCommitment)).resolves.toBe("address_conflict");
      expect(await auditRows(accountB, "confirmation_conflict")).toHaveLength(1);
      expect((await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountB } })).registeredAt).toBeNull();
    });
  });

  describe("resolveAccountIdForWallet", () => {
    it("resolves confirmed registrations only, in any case, regardless of other accounts' pending claims", async () => {
      const address = nextAddress();
      await expect(settlementRepository.resolveAccountIdForWallet(address)).resolves.toBeNull();

      const pending = await register(accountA, address);
      await expect(settlementRepository.resolveAccountIdForWallet(address)).resolves.toBeNull();

      await register(accountB, address);
      const owner = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountB } });
      await confirm(accountB, address, owner.registrationCommitment);

      await expect(settlementRepository.resolveAccountIdForWallet(address)).resolves.toBe(accountB);
      await expect(settlementRepository.resolveAccountIdForWallet(address.toUpperCase().replace("0X", "0x"))).resolves.toBe(accountB);
      expect(pending.registeredAt).toBeNull();
    });

    it("does not treat a LIKE wildcard in the lookup as a pattern", async () => {
      const address = nextAddress();
      const claim = await register(accountA, address);
      await confirm(accountA, address, claim.registrationCommitment);

      await expect(settlementRepository.resolveAccountIdForWallet(`${address.slice(0, 10)}%`)).resolves.toBeNull();
      await expect(settlementRepository.resolveAccountIdForWallet(`${address.slice(0, 10)}_${address.slice(11)}`)).resolves.toBeNull();
    });
  });

  describe("reconcileWalletRegistration", () => {
    const reconcileInput = (
      claim: { walletAddress: string; registrationCommitment: string },
      overrides: Partial<{ expectedWalletAddress: string; expectedRegistrationCommitment: string }> = {},
    ) => ({
      accountId: accountA,
      expectedWalletAddress: claim.walletAddress,
      expectedRegistrationCommitment: claim.registrationCommitment,
      evidence: nextEvidence(),
      registeredAt: new Date("2026-11-01T10:05:00.000Z"),
      changedAt: new Date("2026-11-01T10:06:00.000Z"),
      actorAccountId: staffAccount,
      ...overrides,
    });

    it("confirms the verified claim with its evidence and audits the reconciliation", async () => {
      const claim = await register(accountA, nextAddress());
      const input = reconcileInput(claim);

      const reconciled = await walletRepository.reconcileWalletRegistration(input);

      expect(reconciled).toMatchObject({
        kind: "reconciled",
        outcome: "confirmed",
        wallet: {
          walletAddress: claim.walletAddress,
          registeredAt: input.registeredAt,
          registrationTxHash: input.evidence.transactionHash,
          registrationBlockNumber: 12n,
        },
      });
      const audit = await auditRows(accountA, "reconciled");
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorAccountId: staffAccount, resourceType: "wallet_registration" });
    });

    it("refuses, and writes nothing, when the account replaced the claim after the evidence was verified", async () => {
      const verified = await register(accountA, nextAddress());
      const replacementAddress = nextAddress();
      const replacement = await register(accountA, replacementAddress);

      await expect(walletRepository.reconcileWalletRegistration(reconcileInput(verified))).rejects.toBeInstanceOf(
        WalletRegistrationChangedError,
      );
      // Same address but the commitment was re-issued: also a different claim.
      await expect(
        walletRepository.reconcileWalletRegistration(
          reconcileInput(replacement, { expectedRegistrationCommitment: verified.registrationCommitment }),
        ),
      ).rejects.toBeInstanceOf(WalletRegistrationChangedError);

      const row = await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } });
      expect(row).toMatchObject({
        walletAddress: replacementAddress,
        registrationCommitment: replacement.registrationCommitment,
        registeredAt: null,
        registrationTxHash: null,
      });
      expect(await auditRows(accountA, "reconciled")).toHaveLength(0);
    });

    it("still lets staff attach evidence to a registration that was confirmed without any", async () => {
      const address = nextAddress();
      const claim = await register(accountA, address);
      // Confirmed before evidence was kept: registered_at and nothing else.
      await database.walletRegistration.update({ where: { accountId: accountA }, data: { registeredAt: new Date() } });
      const input = reconcileInput(claim);

      const reconciled = await walletRepository.reconcileWalletRegistration(input);

      expect(reconciled).toMatchObject({
        kind: "reconciled",
        outcome: "evidence_recorded",
        wallet: { registrationTxHash: input.evidence.transactionHash, registrationBlockNumber: 12n },
      });
    });

    it("answers address_claimed, and audits the conflict with the staff actor, when another account holds the address confirmed", async () => {
      const address = nextAddress();
      const owner = await register(accountB, address);
      await confirm(accountB, address, owner.registrationCommitment);
      // A's claim on the address was staged before B confirmed it (the register path now refuses).
      const claim = await database.walletRegistration.create({
        data: { accountId: accountA, walletAddress: address, registrationCommitment: nextCommitment() },
      });

      await expect(walletRepository.reconcileWalletRegistration(reconcileInput(claim))).rejects.toMatchObject({
        reason: "address_claimed",
      });

      const conflicts = await auditRows(accountA, "confirmation_conflict");
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        actorAccountId: staffAccount,
        changes: { wallet_address: address, holder_account_id: accountB, source: "manual_reconcile" },
      });
      expect((await database.walletRegistration.findUniqueOrThrow({ where: { accountId: accountA } })).registeredAt).toBeNull();
      expect(await auditRows(accountA, "reconciled")).toHaveLength(0);
    });
  });
});
