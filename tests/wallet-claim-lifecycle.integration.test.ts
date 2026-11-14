import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { isUniqueViolation } from "../src/infrastructure/database/unique-violation.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import {
  WalletAddressConflictError,
  WalletRegistrationChangedError,
} from "../src/modules/wallet/repository/wallet.repository.js";

// Wallet claim lifecycle (#146): a pending claim is an account-scoped intent
// that never blocks another account; an address is bound exclusively only once
// it is confirmed, and the database enforces that through the partial unique
// index wallet_registrations_confirmed_address_key.
//
// Every address, commitment and account id is derived from a per-run suffix
// and is lowercase: the database refuses any other spelling
// (wallet_registrations_wallet_address_lowercase_check, the canonical-form
// change, #147), so a mixed-case row cannot be created here, not even directly.
// The two tests that are about letter case therefore pin what is left of it
// with the constraint in force: a case variant is refused at the database, and
// a caller's mixed-case spelling is matched against the stored lowercase row.
// Neither skips: CI fails the job on any skipped test.
const LOWERCASE_CHECK = "wallet_registrations_wallet_address_lowercase_check";
const CONFIRMED_ADDRESS_INDEX = "wallet_registrations_confirmed_address_key";
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

  const register = (accountId: string, walletAddress: string, registrationCommitment = nextCommitment()) =>
    walletRepository.registerWallet({ accountId, walletAddress, registrationCommitment, requestedAt: new Date() });

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

  // The same address spelt with upper-case hex digits: what a caller may still
  // send and the database no longer stores. The guard makes the one run in about
  // three million whose random suffix has no letter at all fail loudly, since
  // the "variant" would then be the address itself and prove nothing.
  const upperCaseSpelling = (address: string): string => {
    const spelling = `0x${address.slice(2).toUpperCase()}`;
    expect(spelling).not.toBe(address);
    return spelling;
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

    it("refuses a second confirmed row for an address in any case: a case variant at the lowercase CHECK, an exact duplicate at the confirmed-address unique index", async () => {
      const address = nextAddress();
      const variant = upperCaseSpelling(address);
      await database.walletRegistration.create({
        data: { accountId: accountA, walletAddress: address, registrationCommitment: nextCommitment(), registeredAt: new Date() },
      });
      const insertRow = (accountId: string, walletAddress: string, confirmed: boolean) =>
        authPool.query(
          "INSERT INTO settlement.wallet_registrations (account_id, wallet_address, registration_commitment, registered_at) VALUES ($1, $2, $3, $4)",
          [accountId, walletAddress, nextCommitment(), confirmed ? new Date() : null],
        );
      const lowercaseCheckViolation = { code: "23514", constraint: LOWERCASE_CHECK };
      const confirmedAddressViolation = { code: "23505", constraint: CONFIRMED_ADDRESS_INDEX };

      // A case variant of the confirmed address cannot be stored at all: not as
      // a pending claim and not as a confirmed row. The CHECK refuses it before
      // any index sees the row, so a second spelling never even reaches the
      // unique index.
      await expect(insertRow(accountB, variant, false)).rejects.toMatchObject(lowercaseCheckViolation);
      await expect(insertRow(accountB, variant, true)).rejects.toMatchObject(lowercaseCheckViolation);

      // An exact duplicate is stored as a pending claim (pending claims overlap
      // by design). Moving that claim onto the variant is refused by the CHECK too.
      await database.walletRegistration.create({
        data: { accountId: accountB, walletAddress: address, registrationCommitment: nextCommitment() },
      });
      await expect(
        authPool.query("UPDATE settlement.wallet_registrations SET wallet_address = $2 WHERE account_id = $1", [accountB, variant]),
      ).rejects.toMatchObject(lowercaseCheckViolation);

      // Confirming the duplicate beside the first one is refused by the partial
      // unique index, from a typed call (P2002), from a raw UPDATE and as an INSERT
      // of an already confirmed row (both 23505, naming the index).
      await expect(
        database.walletRegistration.update({ where: { accountId: accountB }, data: { registeredAt: new Date() } }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        authPool.query("UPDATE settlement.wallet_registrations SET registered_at = now() WHERE account_id = $1", [accountB]),
      ).rejects.toMatchObject(confirmedAddressViolation);
      await expect(insertRow(accountC, address, true)).rejects.toMatchObject(confirmedAddressViolation);

      // Every refused statement wrote nothing: in any case, one account holds the
      // address confirmed, and the other still holds only its pending claim.
      const { rows } = await authPool.query<{ account_id: string; wallet_address: string; confirmed: boolean }>(
        `SELECT account_id, wallet_address, registered_at IS NOT NULL AS confirmed
         FROM settlement.wallet_registrations
         WHERE lower(wallet_address) = lower($1)
         ORDER BY account_id`,
        [variant],
      );
      expect(rows).toEqual([
        { account_id: accountA, wallet_address: address, confirmed: true },
        { account_id: accountB, wallet_address: address, confirmed: false },
      ]);
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

      await walletRepository.registerWallet({ accountId: accountA, walletAddress: x, registrationCommitment: c1, requestedAt: t1 });
      const replaced = await walletRepository.registerWallet({ accountId: accountA, walletAddress: y, registrationCommitment: c2, requestedAt: t2 });

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

    it("treats a mixed-case spelling of a stored address as the same address: replay, block and resolve case-insensitively", async () => {
      const address = nextAddress();
      const spelling = upperCaseSpelling(address);
      const commitment = nextCommitment();
      await database.walletRegistration.create({
        data: { accountId: accountA, walletAddress: address, registrationCommitment: commitment, registeredAt: new Date() },
      });

      // The row is stored lowercase (the CHECK allows nothing else); the caller
      // spells the address differently. registerWallet canonicalises the input.
      await expect(register(accountA, spelling)).resolves.toMatchObject({ walletAddress: address, registrationCommitment: commitment });
      await expect(register(accountB, spelling)).rejects.toMatchObject({ reason: "address_claimed" });
      await expect(settlementRepository.resolveAccountIdForWallet(spelling)).resolves.toBe(accountA);
      await expect(settlementRepository.resolveAccountIdForWallet(address)).resolves.toBe(accountA);

      // The replay and the refused claim wrote nothing.
      const rows = await database.walletRegistration.findMany({ where: { accountId: { in: accountIds } } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ accountId: accountA, walletAddress: address, registrationCommitment: commitment });
      expect(await auditRows(accountA, "requested")).toHaveLength(0);
      expect(await auditRows(accountB, "requested")).toHaveLength(0);
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
