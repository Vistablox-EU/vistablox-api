import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  AccountRecoveryCodeRepository,
  ConsumedAccountRecoveryCode,
} from "./account-recovery-code.repository.js";

export class PrismaAccountRecoveryCodeRepository implements AccountRecoveryCodeRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async rotate(input: {
    accountId: string;
    codeHash: string;
    createdAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.accountRecoveryCode.upsert({
        where: { accountId: input.accountId },
        create: {
          accountId: input.accountId,
          codeHash: input.codeHash,
          createdAt: input.createdAt,
        },
        update: {
          codeHash: input.codeHash,
          createdAt: input.createdAt,
          consumedAt: null,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "authentication.account_recovery_code_rotated",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {},
          createdAt: input.createdAt,
        },
      });
    });
  }

  public async consume(input: {
    accountId: string;
    codeHash: string;
    consumedAt: Date;
  }): Promise<ConsumedAccountRecoveryCode | null> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.accountRecoveryCode.updateMany({
        where: {
          accountId: input.accountId,
          codeHash: input.codeHash,
          consumedAt: null,
        },
        data: { consumedAt: input.consumedAt },
      });
      if (updated.count !== 1) return null;

      const account = await transaction.account.findUniqueOrThrow({
        where: { id: input.accountId },
        select: { betterAuthUserId: true },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "authentication.account_recovery_code_consumed",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {},
          createdAt: input.consumedAt,
        },
      });
      return { betterAuthUserId: account.betterAuthUserId };
    });
  }
}
