import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  StaffInvitationRecord,
  StaffInvitationRepository,
  StaffRole,
} from "./staff-invitation.repository.js";

export class PrismaStaffInvitationRepository implements StaffInvitationRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async createInvitation(input: {
    email: string;
    displayName: string;
    role: StaffRole;
    legalPracticeId: string | null;
    appraisalFirmId: string | null;
    tokenHash: string;
    invitedByAccountId: string;
    traceId: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<StaffInvitationRecord> {
    return this.database.$transaction(async (transaction) => {
      await transaction.staffInvitation.updateMany({
        where: {
          email: input.email,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: input.createdAt },
      });
      const invitation = await transaction.staffInvitation.create({
        data: {
          id: `invite_${ulid()}`,
          email: input.email,
          displayName: input.displayName,
          role: input.role,
          legalPracticeId: input.legalPracticeId,
          appraisalFirmId: input.appraisalFirmId,
          tokenHash: input.tokenHash,
          invitedByAccountId: input.invitedByAccountId,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.invitedByAccountId,
          action: "authentication.staff_invitation_issued",
          resourceType: "staff_invitation",
          resourceId: invitation.id,
          changes: {
            trace_id: input.traceId,
            role: input.role,
            legal_practice_id: input.legalPracticeId,
            appraisal_firm_id: input.appraisalFirmId,
            expires_at: input.expiresAt.toISOString(),
          },
        },
      });
      return toRecord(invitation);
    });
  }

  public async revokeInvitation(input: {
    invitationId: string;
    actorAccountId: string;
    traceId: string;
    revokedAt: Date;
    reason: "delivery_failed";
  }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const revoked = await transaction.staffInvitation.updateMany({
        where: { id: input.invitationId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: input.revokedAt },
      });
      if (revoked.count !== 1) return;
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "authentication.staff_invitation_revoked",
          resourceType: "staff_invitation",
          resourceId: input.invitationId,
          changes: { trace_id: input.traceId, reason: input.reason },
        },
      });
    });
  }

  public async claimInvitation(input: {
    tokenHash: string;
    claimId: string;
    claimedAt: Date;
    staleBefore: Date;
  }): Promise<StaffInvitationRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const claimed = await transaction.staffInvitation.updateMany({
        where: {
          tokenHash: input.tokenHash,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: input.claimedAt },
          OR: [{ claimId: null }, { claimedAt: { lt: input.staleBefore } }],
        },
        data: { claimId: input.claimId, claimedAt: input.claimedAt },
      });
      if (claimed.count !== 1) return null;
      const invitation = await transaction.staffInvitation.findUniqueOrThrow({
        where: { tokenHash: input.tokenHash },
      });
      return toRecord(invitation);
    });
  }

  public async releaseClaim(input: { invitationId: string; claimId: string }): Promise<void> {
    await this.database.staffInvitation.updateMany({
      where: {
        id: input.invitationId,
        claimId: input.claimId,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { claimId: null, claimedAt: null },
    });
  }

  public async completeAcceptance(input: {
    invitationId: string;
    claimId: string;
    betterAuthUserId: string;
    traceId: string;
    acceptedAt: Date;
  }): Promise<{ accountId: string } | null> {
    return this.database.$transaction(async (transaction) => {
      const invitation = await transaction.staffInvitation.findFirst({
        where: {
          id: input.invitationId,
          claimId: input.claimId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: input.acceptedAt },
        },
      });
      if (invitation === null) return null;

      const account = await transaction.account.findUnique({
        where: { betterAuthUserId: input.betterAuthUserId },
        select: { id: true },
      });
      if (account === null) {
        throw new Error("Invited Better Auth user has no VistaBlox account mapping");
      }
      await transaction.staffRoleAssignment.create({
        data: {
          id: `role_${ulid()}`,
          accountId: account.id,
          role: invitation.role,
          legalPracticeId: invitation.legalPracticeId,
          appraisalFirmId: invitation.appraisalFirmId,
          grantedAt: input.acceptedAt,
        },
      });
      const accepted = await transaction.staffInvitation.updateMany({
        where: {
          id: input.invitationId,
          claimId: input.claimId,
          acceptedAt: null,
          revokedAt: null,
        },
        data: {
          acceptedAccountId: account.id,
          acceptedAt: input.acceptedAt,
          claimId: null,
          claimedAt: null,
        },
      });
      if (accepted.count !== 1) {
        throw new Error("Staff invitation changed during acceptance");
      }
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: account.id,
          action: "authentication.staff_invitation_accepted",
          resourceType: "staff_invitation",
          resourceId: input.invitationId,
          changes: {
            trace_id: input.traceId,
            role: invitation.role,
          },
        },
      });
      return { accountId: account.id };
    });
  }
}

function toRecord(input: {
  id: string;
  email: string;
  displayName: string;
  role: string;
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
  tokenHash: string;
  claimId: string | null;
  expiresAt: Date;
}): StaffInvitationRecord {
  if (
    input.role !== "admin_operations" &&
    input.role !== "legal_partner" &&
    input.role !== "appraisal_partner"
  ) {
    throw new Error(`Unknown staff invitation role: ${input.role}`);
  }
  return {
    invitationId: input.id,
    email: input.email,
    displayName: input.displayName,
    role: input.role,
    legalPracticeId: input.legalPracticeId,
    appraisalFirmId: input.appraisalFirmId,
    tokenHash: input.tokenHash,
    claimId: input.claimId,
    expiresAt: input.expiresAt,
  };
}
