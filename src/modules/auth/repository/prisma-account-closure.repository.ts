import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  AccountClosureRepository,
  AccountClosureRequestRecord,
  AccountClosureRequestStatus,
  ClosureTarget,
  PendingClosureRequestReader,
  PendingClosureRequestSnapshot,
} from "./account-closure.repository.js";

export class PrismaAccountClosureRepository
  implements AccountClosureRepository, PendingClosureRequestReader
{
  public constructor(private readonly database: DatabaseClient) {}

  public async getPending(accountId: string): Promise<PendingClosureRequestSnapshot | null> {
    const found = await this.database.accountClosureRequest.findFirst({
      where: { accountId, status: "pending" },
      select: { reason: true, requestedAt: true },
    });
    return found;
  }

  public async findTarget(accountId: string): Promise<ClosureTarget | null> {
    const account = await this.database.account.findUnique({
      where: { id: accountId },
      select: { id: true, betterAuthUserId: true, status: true },
    });
    if (account === null) return null;
    return {
      accountId: account.id,
      betterAuthUserId: account.betterAuthUserId,
      status: account.status,
    };
  }

  public async findPendingForAccount(
    accountId: string,
  ): Promise<AccountClosureRequestRecord | null> {
    const found = await this.database.accountClosureRequest.findFirst({
      where: { accountId, status: "pending" },
    });
    return found === null ? null : toRecord(found);
  }

  public async findRequest(requestId: string): Promise<AccountClosureRequestRecord | null> {
    const found = await this.database.accountClosureRequest.findUnique({
      where: { id: requestId },
    });
    return found === null ? null : toRecord(found);
  }

  public async create(input: {
    accountId: string;
    reason: string | null;
    requestedAt: Date;
  }): Promise<AccountClosureRequestRecord> {
    const created = await this.database.accountClosureRequest.create({
      data: {
        id: `closure_request_${ulid()}`,
        accountId: input.accountId,
        reason: input.reason,
        requestedAt: input.requestedAt,
      },
    });
    return toRecord(created);
  }

  public async cancel(input: {
    requestId: string;
    accountId: string;
    cancelledAt: Date;
  }): Promise<AccountClosureRequestRecord | null> {
    const updated = await this.database.accountClosureRequest.updateMany({
      where: { id: input.requestId, accountId: input.accountId, status: "pending" },
      data: { status: "cancelled", resolvedAt: input.cancelledAt },
    });
    if (updated.count === 0) return null;
    return this.findRequest(input.requestId);
  }

  public async listPending(): Promise<AccountClosureRequestRecord[]> {
    const found = await this.database.accountClosureRequest.findMany({
      where: { status: "pending" },
      orderBy: { requestedAt: "asc" },
    });
    return found.map(toRecord);
  }

  public async decide(input: {
    requestId: string;
    reviewerAccountId: string;
    decision: "approved" | "rejected";
    note: string | null;
    decidedAt: Date;
  }): Promise<AccountClosureRequestRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const updated = await transaction.accountClosureRequest.updateMany({
        where: { id: input.requestId, status: "pending" },
        data: {
          status: input.decision,
          resolvedAt: input.decidedAt,
          resolvedBy: input.reviewerAccountId,
          resolutionNote: input.note,
        },
      });
      if (updated.count === 0) return null;
      const request = await transaction.accountClosureRequest.findUniqueOrThrow({
        where: { id: input.requestId },
      });
      if (input.decision === "approved") {
        await transaction.account.update({
          where: { id: request.accountId },
          data: { status: "suspended_restricted", updatedAt: input.decidedAt },
        });
      }
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.reviewerAccountId,
          action:
            input.decision === "approved"
              ? "authentication.customer_account_closed"
              : "authentication.customer_closure_request_rejected",
          resourceType: "account",
          resourceId: request.accountId,
          changes: {
            closure_request_id: request.id,
            note: input.note,
          },
          createdAt: input.decidedAt,
        },
      });
      return toRecord(request);
    });
  }
}

function toRecord(row: {
  id: string;
  accountId: string;
  status: string;
  reason: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}): AccountClosureRequestRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    status: asStatus(row.status),
    reason: row.reason,
    requestedAt: row.requestedAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolutionNote: row.resolutionNote,
  };
}

function asStatus(value: string): AccountClosureRequestStatus {
  if (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error(`Unknown closure request status: ${value}`);
}
