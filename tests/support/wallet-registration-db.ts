import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import type { DatabaseClient } from "../../src/infrastructure/database/prisma.js";

/**
 * Accounts with a wallet_registrations row for the integration suites, created
 * with unique ids and removed again (including the audit rows written about
 * them). A registration row needs an account, which needs a Better Auth user.
 */
export class WalletRegistrationFixtures {
  public readonly suffix = randomUUID().replace(/-/g, "").slice(0, 16);
  private readonly pool: Pool;
  private readonly accountIds: string[] = [];
  private counter = 0;

  public constructor(
    private readonly database: DatabaseClient,
    databaseUrl: string,
  ) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  public async createRegistration(
    options: {
      registeredAt?: Date | null;
      walletAddress?: string;
      commitment?: string;
    } = {},
  ): Promise<{ accountId: string; walletAddress: string; commitment: string }> {
    this.counter += 1;
    const tag = `${this.suffix}_${this.counter}`;
    const accountId = `account_walletreg_${tag}`;
    const betterAuthUserId = `auth_walletreg_${tag}`;
    const walletAddress = options.walletAddress ?? `0xWalletReg${tag}`;
    const commitment = options.commitment ?? `0xCommit${tag}`;
    await this.pool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Wallet Registration Test", `walletreg-${tag}@example.test`, true, "customer"],
    );
    await this.database.account.create({ data: { id: accountId, betterAuthUserId } });
    await this.database.walletRegistration.create({
      data: {
        accountId,
        walletAddress,
        registrationCommitment: commitment,
        registeredAt: options.registeredAt ?? null,
      },
    });
    this.accountIds.push(accountId);
    return { accountId, walletAddress, commitment };
  }

  /** A valid transaction hash no other test run can have used: this run's suffix plus the tag. */
  public uniqueHash(tag: string): string {
    return `0x${this.suffix.padEnd(32, "0").slice(0, 32)}${Buffer.from(tag).toString("hex").padEnd(32, "0").slice(0, 32)}`;
  }

  /**
   * Holds the row lock on a registration in a transaction of its own, runs
   * `whileLocked` (which should start the operation under test and check that
   * it is still waiting), then lets `change` modify the row and commits. A
   * write that does not take the same lock first would act on the state it
   * read before the change.
   */
  public async withRowLocked<T>(
    accountId: string,
    whileLocked: () => Promise<T>,
    change: (transaction: Parameters<Parameters<DatabaseClient["$transaction"]>[0]>[0]) => Promise<void>,
  ): Promise<T> {
    let lockTaken!: () => void;
    const locked = new Promise<void>((resolve) => (lockTaken = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT account_id FROM settlement.wallet_registrations WHERE account_id = ${accountId} FOR UPDATE`;
      lockTaken();
      await gate;
      await change(transaction);
    });
    await locked;
    try {
      return await whileLocked();
    } finally {
      release();
      await holder;
    }
  }

  public query(sql: string, params: unknown[] = []) {
    return this.pool.query(sql, params);
  }

  public async auditActions(accountId: string): Promise<string[]> {
    const rows = await this.database.auditLog.findMany({
      where: { resourceType: "wallet_registration", resourceId: accountId },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    return rows.map((row) => row.action);
  }

  public async cleanup(): Promise<void> {
    await this.database.auditLog.deleteMany({
      where: { resourceType: "wallet_registration", resourceId: { in: this.accountIds } },
    });
    await this.database.walletRegistration.deleteMany({ where: { accountId: { in: this.accountIds } } });
    await this.database.account.deleteMany({ where: { id: { in: this.accountIds } } });
    await this.pool.query('DELETE FROM "auth_user" WHERE "email" LIKE $1', [`walletreg-${this.suffix}_%@example.test`]);
    await this.pool.end();
  }
}
