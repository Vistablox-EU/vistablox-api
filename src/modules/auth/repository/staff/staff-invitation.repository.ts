export type StaffRole = "admin_operations" | "legal_partner" | "appraisal_partner";

export interface StaffInvitationRecord {
  invitationId: string;
  email: string;
  displayName: string;
  role: StaffRole;
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
  tokenHash: string;
  claimId: string | null;
  expiresAt: Date;
}

export interface StaffInvitationRepository {
  createInvitation(input: {
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
  }): Promise<StaffInvitationRecord>;
  revokeInvitation(input: {
    invitationId: string;
    actorAccountId: string;
    traceId: string;
    revokedAt: Date;
    reason: "delivery_failed";
  }): Promise<void>;
  claimInvitation(input: {
    tokenHash: string;
    claimId: string;
    claimedAt: Date;
    staleBefore: Date;
  }): Promise<StaffInvitationRecord | null>;
  releaseClaim(input: { invitationId: string; claimId: string }): Promise<void>;
  completeAcceptance(input: {
    invitationId: string;
    claimId: string;
    betterAuthUserId: string;
    traceId: string;
    acceptedAt: Date;
  }): Promise<{ accountId: string } | null>;
}
