import { ulid } from "ulid";

import type { DatabaseClient } from "../../../../infrastructure/database/prisma.js";
import type {
  StaffBootstrapCounts,
  StaffBootstrapIssueResult,
  StaffBootstrapRepository,
} from "./staff-bootstrap.repository.js";

/**
 * pg_advisory_xact_lock key for the first-admin bootstrap. Any constant
 * works as long as nothing else uses it; exported so the integration test
 * can hold it and prove a second run really waits.
 */
export const STAFF_BOOTSTRAP_ADVISORY_LOCK_KEY = 7_311_040_001;

// How long a run waits for another run's lock before giving up, and the
// transaction's own ceiling. The CLI is interactive: failing after a few
// seconds with "try again" beats hanging in the terminal.
const LOCK_TIMEOUT = "15s";
const TRANSACTION_TIMEOUT_MS = 30_000;

export class PrismaStaffBootstrapRepository implements StaffBootstrapRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async countBootstrapState(now: Date): Promise<StaffBootstrapCounts> {
    const [activeStaffAccounts, activeAdminOperationsHolders, pendingBootstrapInvitations] =
      await Promise.all([
        this.database.account.count({
          where: { status: "active", staffRoles: { some: { revokedAt: null } } },
        }),
        this.database.account.count({ where: activeAdminWhere }),
        this.database.staffInvitation.count({
          where: {
            issuedVia: "cli_bootstrap",
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        }),
      ]);
    return { activeStaffAccounts, activeAdminOperationsHolders, pendingBootstrapInvitations };
  }

  public async issueBootstrapInvitation(input: {
    email: string;
    displayName: string;
    tokenHash: string;
    traceId: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<StaffBootstrapIssueResult> {
    return this.database.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
        // Serializes concurrent bootstrap runs: the second one waits here
        // until the first commits, then sees its result below.
        await transaction.$queryRaw`
          SELECT 1 AS locked FROM pg_advisory_xact_lock(${STAFF_BOOTSTRAP_ADVISORY_LOCK_KEY}::bigint)
        `;
        // Row-lock every live invitation this run may revoke before counting
        // admins. An acceptance of one of them that is already mid-commit
        // finishes first (and its new admin is counted below); one that
        // starts later blocks on this lock and then finds the row revoked,
        // so completeAcceptance rolls back instead of granting the role.
        const live = await transaction.$queryRaw<
          Array<{ invitation_id: string; issued_via: string; expires_at: Date }>
        >`
          SELECT "invitation_id", "issued_via", "expires_at"
          FROM "auth"."staff_invitations"
          WHERE "accepted_at" IS NULL
            AND "revoked_at" IS NULL
            AND ("issued_via" = 'cli_bootstrap' OR "email" = ${input.email})
          FOR UPDATE
        `;

        const admins = await transaction.account.count({ where: activeAdminWhere });
        if (admins > 0) return { outcome: "admin_exists" as const };

        let replacedPendingBootstrapInvitations = 0;
        for (const invitation of live) {
          const isBootstrap = invitation.issued_via === "cli_bootstrap";
          if (isBootstrap && new Date(invitation.expires_at) > input.createdAt) {
            replacedPendingBootstrapInvitations += 1;
          }
          await transaction.staffInvitation.update({
            where: { id: invitation.invitation_id },
            data: { revokedAt: input.createdAt },
          });
          await transaction.auditLog.create({
            data: {
              id: `audit_${ulid()}`,
              actorAccountId: null,
              action: "authentication.staff_invitation_revoked",
              resourceType: "staff_invitation",
              resourceId: invitation.invitation_id,
              changes: {
                trace_id: input.traceId,
                // bootstrap_reissued: an earlier bootstrap link (lost or
                // expired) is replaced by this run. superseded_by_bootstrap:
                // a staff-issued invitation for the same email, which the
                // one-pending-invitation-per-email index would otherwise
                // collide with.
                reason: isBootstrap ? "bootstrap_reissued" : "superseded_by_bootstrap",
              },
            },
          });
        }

        const invitation = await transaction.staffInvitation.create({
          data: {
            id: `invite_${ulid()}`,
            email: input.email,
            displayName: input.displayName,
            role: "admin_operations",
            legalPracticeId: null,
            appraisalFirmId: null,
            tokenHash: input.tokenHash,
            invitedByAccountId: null,
            issuedVia: "cli_bootstrap",
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
          },
        });
        await transaction.auditLog.create({
          data: {
            id: `audit_${ulid()}`,
            actorAccountId: null,
            action: "authentication.staff_bootstrap_invitation_issued",
            resourceType: "staff_invitation",
            resourceId: invitation.id,
            changes: {
              trace_id: input.traceId,
              email: input.email,
              role: "admin_operations",
              issued_via: "cli_bootstrap",
              expires_at: input.expiresAt.toISOString(),
              revoked_invitation_count: live.length,
            },
          },
        });
        return {
          outcome: "issued" as const,
          invitationId: invitation.id,
          expiresAt: invitation.expiresAt,
          replacedPendingBootstrapInvitations,
          revokedInvitations: live.length,
        };
      },
      { maxWait: 5_000, timeout: TRANSACTION_TIMEOUT_MS },
    );
  }
}

// "Active admin" = an active account with an unrevoked admin_operations
// assignment. Offboarding revokes every role and suspends the account, so a
// former admin never counts.
const activeAdminWhere = {
  status: "active",
  staffRoles: { some: { role: "admin_operations", revokedAt: null } },
};
