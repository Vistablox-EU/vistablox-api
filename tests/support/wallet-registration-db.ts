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
