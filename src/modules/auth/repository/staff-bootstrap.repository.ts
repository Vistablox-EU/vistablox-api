/** Counts only -- no email, name, or id -- so `--check` can print them safely. */
export interface StaffBootstrapCounts {
  /** Accounts with status "active" holding any unrevoked staff role. */
  activeStaffAccounts: number;
  /** Accounts with status "active" holding an unrevoked admin_operations role. */
  activeAdminOperationsHolders: number;
  /** Bootstrap invitations not accepted, not revoked, and not yet expired. */
  pendingBootstrapInvitations: number;
}

export type StaffBootstrapIssueResult =
  | { outcome: "admin_exists" }
  | {
      outcome: "issued";
      invitationId: string;
      expiresAt: Date;
      /** Earlier bootstrap invitations that were still usable and are now revoked. */
      replacedPendingBootstrapInvitations: number;
      /** Every invitation revoked by this run (bootstrap, expired bootstrap, same-email). */
      revokedInvitations: number;
    };

export interface StaffBootstrapRepository {
  countBootstrapState(now: Date): Promise<StaffBootstrapCounts>;
  /**
   * In one transaction, serialized on an advisory lock: refuse if an active
   * account holds admin_operations; otherwise revoke any live bootstrap
   * invitation (and any live invitation for the same email), then create the
   * new bootstrap invitation. Audited in the same transaction.
   */
  issueBootstrapInvitation(input: {
    email: string;
    displayName: string;
    tokenHash: string;
    traceId: string;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<StaffBootstrapIssueResult>;
}
