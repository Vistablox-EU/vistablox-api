import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { TotpFactorRecord, TotpRepository } from "./totp.repository.js";

export class PrismaTotpRepository implements TotpRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async getAccountLabel(accountId: string): Promise<string> {
    const account = await this.database.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { protectedContactEmail: true },
    });
    return account.protectedContactEmail ?? accountId;
  }

  public async getFactor(accountId: string): Promise<TotpFactorRecord | null> {
    const factor = await this.database.mfaTotpFactor.findUnique({ where: { accountId } });
    return factor === null
      ? null
      : {
          accountId: factor.accountId,
          secret: factor.secret,
          enrolledAt: factor.enrolledAt,
          lastUsedAt: factor.lastUsedAt,
        };
  }

  public async enroll(input: {
    accountId: string;
    secret: string;
    backupCodeHashes: string[];
    enrolledAt: Date;
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.mfaTotpFactor.upsert({
        where: { accountId: input.accountId },
        create: {
          accountId: input.accountId,
          secret: input.secret,
          enrolledAt: input.enrolledAt,
        },
        update: {
          secret: input.secret,
          enrolledAt: input.enrolledAt,
          lastUsedAt: null,
        },
      });
      // Re-enrollment replaces the whole backup-code set (AD-177): a fresh
      // secret makes any previously issued codes meaningless to keep around.
      await transaction.mfaBackupCode.deleteMany({ where: { accountId: input.accountId } });
      await transaction.mfaBackupCode.createMany({
        data: input.backupCodeHashes.map((codeHash) => ({
          id: `bkc_${ulid()}`,
          accountId: input.accountId,
          codeHash,
          createdAt: input.enrolledAt,
        })),
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "auth.totp_enrolled",
          resourceType: "account",
          resourceId: input.accountId,
          changes: { backup_code_count: input.backupCodeHashes.length },
          createdAt: input.enrolledAt,
        },
      });
    });
  }

  public async recordTotpUse(accountId: string, usedAt: Date): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.mfaTotpFactor.update({
        where: { accountId },
        data: { lastUsedAt: usedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: accountId,
          action: "auth.totp_verified",
          resourceType: "account",
          resourceId: accountId,
          changes: {},
          createdAt: usedAt,
        },
      });
    });
  }

  public async countUnconsumedBackupCodes(accountId: string): Promise<number> {
    return this.database.mfaBackupCode.count({
      where: { accountId, consumedAt: null },
    });
  }

  public async consumeBackupCode(input: {
    accountId: string;
    codeHash: string;
    consumedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.mfaBackupCode.updateMany({
        where: { accountId: input.accountId, codeHash: input.codeHash, consumedAt: null },
        data: { consumedAt: input.consumedAt },
      });
      if (updated.count !== 1) return false;

      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "auth.totp_backup_code_consumed",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {},
          createdAt: input.consumedAt,
        },
      });
      return true;
    });
  }
}
