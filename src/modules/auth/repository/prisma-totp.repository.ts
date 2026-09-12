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

  public async enroll(input: { accountId: string; secret: string; enrolledAt: Date }): Promise<void> {
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
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "auth.totp_enrolled",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {},
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

  public async recordSessionFreshAuth(input: {
    accountId: string;
    providerSessionId: string;
    verifiedAt: Date;
  }): Promise<void> {
    await this.database.session.updateMany({
      where: {
        accountId: input.accountId,
        betterAuthSessionId: input.providerSessionId,
        status: "active",
      },
      data: { lastFreshAuthAt: input.verifiedAt },
    });
  }
}
