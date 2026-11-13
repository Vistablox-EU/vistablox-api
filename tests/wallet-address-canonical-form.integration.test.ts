import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import { WalletAddressConflictError } from "../src/modules/wallet/repository/wallet.repository.js";
import { toChecksumWalletAddress } from "../src/shared/domain/wallet-address.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// "One address, one canonical spelling" for settlement.wallet_registrations:
// the repository canonicalises what it is given, and the database refuses any
// other spelling (wallet_registrations_wallet_address_lowercase_check), so
// case variants of one address can no longer sit under different accounts.
//
// Every address here is random per run and every row is removed again, so the
// suite can run next to the others against one database.
describe.skipIf(databaseUrl === undefined)("wallet address canonical form (PostgreSQL integration)", () => {
  const suffix = randomUUID().replace(/-/g, "");
  const pool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaWalletRepository(database);

  const accountIds: string[] = [];
  const requestedAt = new Date("2026-11-13T10:00:00.000Z");
  let sequence = 0;

  const randomAddress = () => `0x${randomBytes(20).toString("hex")}`;

  async function createAccount(): Promise<string> {
    sequence += 1;
    const accountId = `account_wallet_canonical_${suffix}_${sequence}`;
    const betterAuthUserId = `auth_wallet_canonical_${suffix}_${sequence}`;
    await pool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Wallet Canonical Test", `wallet-canonical-${suffix}-${sequence}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    accountIds.push(accountId);
    return accountId;
  }

  const register = (accountId: string, walletAddress: string, commitment = `commitment_${accountId}`) =>
    repository.registerWallet({ accountId, walletAddress, registrationCommitment: commitment, requestedAt });

  const rowsForAddress = async (address: string) =>
    (
      await pool.query<{ account_id: string }>(
        'SELECT "account_id" FROM "settlement"."wallet_registrations" WHERE lower("wallet_address") = lower($1)',
        [address],
      )
    ).rows;

  const confirm = (accountId: string) =>
    database.walletRegistration.update({
      where: { accountId },
      data: { registeredAt: new Date("2026-11-13T10:05:00.000Z"), registrationTxHash: `0x${randomBytes(32).toString("hex")}` },
    });

  async function cleanUp(ids: string[]) {
    await database.auditLog.deleteMany({ where: { resourceId: { in: ids } } });
    await database.walletRegistration.deleteMany({ where: { accountId: { in: ids } } });
  }

  beforeAll(async () => {
    // Fails loudly (instead of silently testing nothing) when the database is
    // behind the migration this suite is about.
    const check = await pool.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'wallet_registrations_wallet_address_lowercase_check'",
    );
    expect(check.rowCount, "run npm run db:migrate:deploy against the test database first").toBe(1);
  });

  afterAll(async () => {
    await cleanUp(accountIds);
    await database.account.deleteMany({ where: { id: { in: accountIds } } });
    await pool.query('DELETE FROM "auth_user" WHERE "id" LIKE $1', [`auth_wallet_canonical_${suffix}_%`]);
    await Promise.all([database.$disconnect(), pool.end()]);
  });

  describe("registerWallet", () => {
    it("stores, returns and audits the lowercase form for an EIP-55 input", async () => {
      const accountId = await createAccount();
      const canonical = randomAddress();
      const eip55 = toChecksumWalletAddress(canonical);
      expect(eip55).not.toBe(canonical);

      const registered = await register(accountId, eip55);

      expect(registered.walletAddress).toBe(canonical);
      const stored = await pool.query<{ wallet_address: string }>(
        'SELECT "wallet_address" FROM "settlement"."wallet_registrations" WHERE "account_id" = $1',
        [accountId],
      );
      expect(stored.rows).toEqual([{ wallet_address: canonical }]);
      const audit = await database.auditLog.findMany({
        where: { resourceId: accountId, action: "settlement.wallet_registration_requested" },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.changes).toEqual({ wallet_address: canonical });
    });

    it("treats a retry in any spelling as the same registration", async () => {
      const accountId = await createAccount();
      const canonical = randomAddress();
      const spellings = [
        toChecksumWalletAddress(canonical),
        canonical,
        `0x${canonical.slice(2).toUpperCase()}`,
        `  ${canonical}\n`,
        canonical,
      ];

      const first = await register(accountId, spellings[0]!, "commitment_first");
      for (const [index, spelling] of spellings.slice(1).entries()) {
        const replay = await register(accountId, spelling, `commitment_retry_${index}`);
        expect(replay).toEqual(first);
      }

      expect(first.registrationCommitment).toBe("commitment_first");
      expect(await rowsForAddress(canonical)).toEqual([{ account_id: accountId }]);
      expect(
        await database.auditLog.count({
          where: { resourceId: accountId, action: "settlement.wallet_registration_requested" },
        }),
      ).toBe(1);
    });

    it("rejects another account registering any spelling of a confirmed holder's address", async () => {
      const holder = await createAccount();
      const other = await createAccount();
      const canonical = randomAddress();
      await register(holder, canonical);
      await confirm(holder);

      for (const spelling of [
        toChecksumWalletAddress(canonical),
        `0x${canonical.slice(2).toUpperCase()}`,
        ` ${canonical} `,
        canonical,
      ]) {
        const error: unknown = await register(other, spelling).then(
          () => undefined,
          (rejection: unknown) => rejection,
        );
        expect(error).toBeInstanceOf(WalletAddressConflictError);
        expect((error as WalletAddressConflictError).reason).toBe("address_claimed");
      }

      expect(await rowsForAddress(canonical)).toEqual([{ account_id: holder }]);
      expect(await database.walletRegistration.count({ where: { accountId: other } })).toBe(0);
    });

    it("does not treat % or _ in an address as wildcards when looking for a holder", async () => {
      const holder = await createAccount();
      const probeUnderscore = await createAccount();
      const probePercent = await createAccount();
      const canonical = randomAddress();
      await register(holder, canonical);
      await confirm(holder);

      // Each probe would match the holder's address under ILIKE and does not
      // under equality. They are not valid addresses; registerWallet is also
      // reachable by callers that skip the HTTP edge.
      const underscores = `0x${"_".repeat(8)}${canonical.slice(10)}`;
      const percent = `0x%${canonical.slice(-8)}`;

      await expect(register(probeUnderscore, underscores)).resolves.toMatchObject({ walletAddress: underscores });
      await expect(register(probePercent, percent)).resolves.toMatchObject({ walletAddress: percent });
      expect(await rowsForAddress(canonical)).toEqual([{ account_id: holder }]);
    });

    it("leaves exactly one row per address when accounts race with case variants of it", async () => {
      const racers = await Promise.all(Array.from({ length: 6 }, () => createAccount()));
      const outcomes: string[] = [];

      for (let round = 0; round < 20; round += 1) {
        const canonical = randomAddress();
        const spellings = [
          canonical,
          toChecksumWalletAddress(canonical),
          `0x${canonical.slice(2).toUpperCase()}`,
          canonical,
          toChecksumWalletAddress(canonical),
          `0x${canonical.slice(2).toUpperCase()}`,
        ];
        const results = await Promise.allSettled(racers.map((accountId, index) => register(accountId, spellings[index]!)));

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        for (const result of results) {
          if (result.status === "fulfilled") continue;
          // Losers: the pre-check saw the winner (address_claimed) or both
          // reached the insert and the unique index refused the second, which
          // surfaces as a Prisma P2002 until that race is given a clean answer
          // (issue #154).
          const reason = result.reason as { code?: string; reason?: string };
          outcomes.push(reason.code ?? reason.reason ?? "unknown");
          expect(reason instanceof WalletAddressConflictError ? reason.reason : reason.code).toMatch(
            /^(address_claimed|P2002)$/,
          );
        }
        expect(await rowsForAddress(canonical)).toHaveLength(1);
        await cleanUp(racers);
      }
      expect(outcomes.length).toBe(20 * 5);
    }, 60_000);
  });

  describe("database", () => {
    const insert = (accountId: string, address: string) =>
      pool.query(
        'INSERT INTO "settlement"."wallet_registrations" ("account_id", "wallet_address", "registration_commitment") VALUES ($1, $2, $3)',
        [accountId, address, `commitment_${accountId}`],
      );

    it("refuses a mixed-case INSERT and UPDATE, naming the lowercase check", async () => {
      const accountId = await createAccount();
      const canonical = randomAddress();
      const mixed = toChecksumWalletAddress(canonical);

      await expect(insert(accountId, mixed)).rejects.toMatchObject({
        code: "23514",
        constraint: "wallet_registrations_wallet_address_lowercase_check",
      });

      await insert(accountId, canonical);
      await expect(
        pool.query('UPDATE "settlement"."wallet_registrations" SET "wallet_address" = $2 WHERE "account_id" = $1', [
          accountId,
          mixed,
        ]),
      ).rejects.toMatchObject({ code: "23514", constraint: "wallet_registrations_wallet_address_lowercase_check" });
    });

    it("refuses a second account holding the same lowercase address", async () => {
      const first = await createAccount();
      const second = await createAccount();
      const canonical = randomAddress();
      await insert(first, canonical);
      await confirm(first);

      // The code, not the index name: the index that enforces this is
      // replaced when claims become confirmed-only.
      await expect(insert(second, canonical)).rejects.toMatchObject({ code: "23505" });
    });

    it("has the check validated, not merely declared", async () => {
      const result = await pool.query<{ convalidated: boolean; definition: string }>(
        `SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conname = 'wallet_registrations_wallet_address_lowercase_check'
           AND conrelid = 'settlement.wallet_registrations'::regclass`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.convalidated).toBe(true);
      expect(result.rows[0]!.definition).toContain("lower(wallet_address)");
    });
  });
});
