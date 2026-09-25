import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  DeviceReplacementCode,
  DeviceReplacementRepository,
  DeviceReplacementTarget,
} from "./device-replacement.repository.js";

// auth.devices.revocation_reason for a device revoked by completing a
// self-service device replacement (AD-271).
const DEVICE_REPLACEMENT_REVOCATION_REASON = "device_replacement";

// auth.login_methods.method_type for an enrolled device's biometric key.
const DEVICE_KEY_LOGIN_METHOD = "device_key";

// auth.device_replacement_codes row, typed only with the fields this repo reads.
interface DeviceReplacementCodeRow {
  id: string;
  accountId: string;
  sessionId: string | null;
  codeHash: string;
  expiresAt: Date;
  attemptsUsed: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export class PrismaDeviceReplacementRepository implements DeviceReplacementRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async create(input: {
    accountId: string;
    sessionId: string | null;
    codeHash: string;
    expiresAt: Date;
  }): Promise<DeviceReplacementCode> {
    const created = await this.database.deviceReplacementCode.create({
      data: {
        id: `device_replacement_code_${ulid()}`,
        accountId: input.accountId,
        sessionId: input.sessionId,
        codeHash: input.codeHash,
        expiresAt: input.expiresAt,
      },
    });
    return toRecord(created);
  }

  public async findPendingForAccount(accountId: string, now: Date): Promise<DeviceReplacementCode | null> {
    const found = await this.database.deviceReplacementCode.findFirst({
      where: { accountId, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    return found === null ? null : toRecord(found);
  }

  public async findReplacementTarget(accountId: string): Promise<DeviceReplacementTarget | null> {
    const account = await this.database.account.findUnique({
      where: { id: accountId },
      select: {
        protectedContactEmail: true,
        staffRoles: { where: { revokedAt: null }, take: 1, select: { id: true } },
      },
    });
    if (account === null) return null;
    return { contactEmail: account.protectedContactEmail, isStaff: account.staffRoles.length > 0 };
  }

  public async countCreatedSince(accountId: string, since: Date): Promise<number> {
    return this.database.deviceReplacementCode.count({
      where: { accountId, createdAt: { gte: since } },
    });
  }

  public async findLastConsumedAt(accountId: string): Promise<Date | null> {
    const latest = await this.database.deviceReplacementCode.findFirst({
      where: { accountId, consumedAt: { not: null } },
      orderBy: { consumedAt: "desc" },
      select: { consumedAt: true },
    });
    return latest?.consumedAt ?? null;
  }

  public async incrementAttempts(codeId: string, now: Date): Promise<DeviceReplacementCode | null> {
    const result = await this.database.deviceReplacementCode.updateMany({
      where: { id: codeId, consumedAt: null, expiresAt: { gt: now } },
      data: { attemptsUsed: { increment: 1 } },
    });
    if (result.count === 0) return null;
    return this.findByCodeId(codeId);
  }

  public async consumeAndReplace(input: {
    codeId: string;
    codeHash: string;
    now: Date;
    maxAttempts: number;
    accountId: string;
    actorAccountId: string;
    traceId: string;
  }): Promise<{ revokedDeviceIds: string[]; removedLoginMethodCount: number } | null> {
    return this.database.$transaction(async (transaction) => {
      // The atomic gate: exactly one concurrent caller consumes the code. Hash,
      // expiry, single-use, and the attempt cap are all enforced in the WHERE
      // clause, not in a read-then-write. A consumed code commits together with
      // the revocation below, so consumed_at always means a completed
      // replacement (and the cooldown derived from it is never premature).
      const consumed = await transaction.deviceReplacementCode.updateMany({
        where: {
          id: input.codeId,
          codeHash: input.codeHash,
          consumedAt: null,
          expiresAt: { gt: input.now },
          attemptsUsed: { lt: input.maxAttempts },
        },
        data: { consumedAt: input.now },
      });
      if (consumed.count === 0) return null;

      const devices = await transaction.device.findMany({
        where: { accountId: input.accountId, status: "active" },
        select: { deviceId: true },
        orderBy: { createdAt: "asc" },
      });
      const revokedDeviceIds = devices.map((device) => device.deviceId);
      if (revokedDeviceIds.length > 0) {
        await transaction.device.updateMany({
          where: { deviceId: { in: revokedDeviceIds }, status: "active" },
          data: {
            status: "revoked",
            revokedAt: input.now,
            revocationReason: DEVICE_REPLACEMENT_REVOCATION_REASON,
          },
        });
      }
      const removed = await transaction.loginMethod.deleteMany({
        where: { accountId: input.accountId, methodType: DEVICE_KEY_LOGIN_METHOD },
      });

      for (const deviceId of revokedDeviceIds) {
        await transaction.auditLog.create({
          data: {
            id: `audit_${ulid()}`,
            actorAccountId: input.actorAccountId,
            action: "authentication.device_revoked",
            resourceType: "device",
            resourceId: deviceId,
            changes: {
              trace_id: input.traceId,
              account_id: input.accountId,
              reason: DEVICE_REPLACEMENT_REVOCATION_REASON,
            },
            createdAt: input.now,
          },
        });
      }
      if (removed.count > 0) {
        await transaction.auditLog.create({
          data: {
            id: `audit_${ulid()}`,
            actorAccountId: input.actorAccountId,
            action: "authentication.login_method_removed",
            resourceType: "account",
            resourceId: input.accountId,
            changes: {
              trace_id: input.traceId,
              method_type: DEVICE_KEY_LOGIN_METHOD,
              removed_count: removed.count,
              reason: DEVICE_REPLACEMENT_REVOCATION_REASON,
            },
            createdAt: input.now,
          },
        });
      }
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.device_replacement_completed",
          resourceType: "account",
          resourceId: input.accountId,
          changes: {
            trace_id: input.traceId,
            account_id: input.accountId,
            revoked_device_count: revokedDeviceIds.length,
          },
          createdAt: input.now,
        },
      });

      return { revokedDeviceIds, removedLoginMethodCount: removed.count };
    });
  }

  public async revokePendingForAccount(accountId: string, now: Date): Promise<void> {
    await this.database.deviceReplacementCode.updateMany({
      where: { accountId, consumedAt: null },
      data: { consumedAt: now },
    });
  }

  public async recordAuditEvent(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    changes: Record<string, string | number | boolean | null>;
    occurredAt: Date;
  }): Promise<void> {
    await this.database.auditLog.create({
      data: {
        id: `audit_${ulid()}`,
        actorAccountId: input.actorAccountId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        changes: { trace_id: input.traceId, ...input.changes },
        createdAt: input.occurredAt,
      },
    });
  }

  private async findByCodeId(codeId: string): Promise<DeviceReplacementCode | null> {
    const found = await this.database.deviceReplacementCode.findUnique({ where: { id: codeId } });
    return found === null ? null : toRecord(found);
  }
}

function toRecord(row: DeviceReplacementCodeRow): DeviceReplacementCode {
  return {
    id: row.id,
    accountId: row.accountId,
    sessionId: row.sessionId,
    codeHash: row.codeHash,
    expiresAt: row.expiresAt,
    attemptsUsed: row.attemptsUsed,
    consumedAt: row.consumedAt,
    createdAt: row.createdAt,
  };
}
