import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  AccountRepository,
  AccountStatus,
  LocalAccountContext,
} from "./account.repository.js";

export class PrismaAccountRepository implements AccountRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async findByBetterAuthUserId(
    betterAuthUserId: string,
  ): Promise<LocalAccountContext | null> {
    const account = await this.database.account.findUnique({
      where: { betterAuthUserId },
      select: { id: true, status: true },
    });

    return account === null
      ? null
      : { accountId: account.id, status: asAccountStatus(account.status) };
  }

  public async hasActiveStaffRole(
    accountId: string,
    role: "admin_operations",
  ): Promise<boolean> {
    const assignment = await this.database.staffRoleAssignment.findFirst({
      where: { accountId, role, revokedAt: null },
      select: { id: true },
    });
    return assignment !== null;
  }

  public async hasAnyActiveStaffRole(accountId: string): Promise<boolean> {
    const assignment = await this.database.staffRoleAssignment.findFirst({
      where: { accountId, revokedAt: null },
      select: { id: true },
    });
    return assignment !== null;
  }

  public async provision(input: {
    betterAuthUserId: string;
    protectedContactEmail: string | null;
  }): Promise<LocalAccountContext> {
    const account = await this.database.account.upsert({
      where: { betterAuthUserId: input.betterAuthUserId },
      update: {},
      create: {
        id: `acct_${ulid()}`,
        betterAuthUserId: input.betterAuthUserId,
        protectedContactEmail: input.protectedContactEmail,
      },
      select: { id: true, status: true },
    });

    return { accountId: account.id, status: asAccountStatus(account.status) };
  }

  public async syncVerifiedContactEmail(input: {
    betterAuthUserId: string;
    protectedContactEmail: string;
  }): Promise<void> {
    await this.database.account.update({
      where: { betterAuthUserId: input.betterAuthUserId },
      data: { protectedContactEmail: input.protectedContactEmail },
    });
  }
}

function asAccountStatus(status: string): AccountStatus {
  if (
    status === "active" ||
    status === "recovery_review" ||
    status === "suspended_restricted"
  ) {
    return status;
  }
  throw new Error(`Unknown account status: ${status}`);
}
