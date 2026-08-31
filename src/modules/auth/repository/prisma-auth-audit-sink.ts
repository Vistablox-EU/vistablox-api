import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { AuthAuditEvent, AuthAuditSink } from "../application/auth-audit-sink.js";

export class PrismaAuthAuditSink implements AuthAuditSink {
  public constructor(private readonly database: DatabaseClient) {}

  public async record(event: AuthAuditEvent): Promise<void> {
    const account =
      event.betterAuthUserId === null
        ? null
        : await this.database.account.findUnique({
            where: { betterAuthUserId: event.betterAuthUserId },
            select: { id: true },
          });
    const resource = resolveResource(event, account?.id ?? null);
    await this.database.auditLog.createMany({
      data: [
        {
          id: `audit_${ulid()}`,
          eventKey: event.eventKey,
          actorAccountId: event.attributeToSubject ? (account?.id ?? null) : null,
          action: event.action,
          resourceType: resource.type,
          resourceId: resource.id,
          changes: event.changes,
          createdAt: event.occurredAt,
        },
      ],
      skipDuplicates: true,
    });
  }
}

function resolveResource(
  event: AuthAuditEvent,
  accountId: string | null,
): { type: string; id: string } {
  if (event.resourceType === "account" && accountId !== null) {
    return { type: "account", id: accountId };
  }
  if (event.resourceType === "account") {
    return { type: "better_auth_user", id: event.resourceId };
  }
  return { type: event.resourceType, id: event.resourceId };
}
