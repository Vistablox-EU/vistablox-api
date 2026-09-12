export type AccountRecoveryCaseStatus = "open" | "approved" | "rejected" | "completed";

export const recoveryCorroborationCategories = [
  "recent_deposit",
  "recent_investment",
  "last_login",
  "other_policy_approved",
] as const;
export type RecoveryCorroborationCategory = (typeof recoveryCorroborationCategories)[number];

export interface AccountRecoveryCaseRecord {
  id: string;
  accountId: string;
  status: AccountRecoveryCaseStatus;
  freshDiditVerificationRef: string | null;
  reviewedByPrimary: string | null;
  reviewedBySecondary: string | null;
  cooldownEndsAt: Date | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface RecoveryCorroborationFacts {
  lastDeposit: { amountEur: string; recordedAt: Date } | null;
  lastReservation: { amountEur: string; createdAt: Date } | null;
  lastLogin: { authMethod: string; occurredAt: Date } | null;
}

export interface RecoveryCaseTarget {
  accountId: string;
  betterAuthUserId: string;
  status: string;
  contactEmail: string | null;
  isStaff: boolean;
}

/**
 * Full-lockout customer account recovery (ACCOUNT_RECOVERY_POLICY.md). Deliberately
 * a separate repository from the staff-recovery one (StaffAccountLifecycleRepository)
 * even though the shapes rhyme — the two flows have different actors, different
 * evidence requirements (dual review + fresh Didit verification here, none there),
 * and different eligible targets (customers here, staff/partners there).
 */
export interface AccountRecoveryRepository {
  findTargetForRecovery(accountId: string): Promise<RecoveryCaseTarget | null>;
  findOpenCaseForAccount(accountId: string): Promise<AccountRecoveryCaseRecord | null>;
  findCase(caseId: string): Promise<AccountRecoveryCaseRecord | null>;
  openCase(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    openedAt: Date;
  }): Promise<AccountRecoveryCaseRecord>;
  recordDiditSession(input: {
    caseId: string;
    diditReference: string;
    actorAccountId: string;
    traceId: string;
    recordedAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null>;
  getCorroborationFacts(accountId: string): Promise<RecoveryCorroborationFacts>;
  recordPrimaryReview(input: {
    caseId: string;
    reviewerAccountId: string;
    corroborationCategory: RecoveryCorroborationCategory;
    traceId: string;
    reviewedAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null>;
  decideCase(input: {
    caseId: string;
    reviewerAccountId: string;
    decision: "approved" | "rejected";
    reason: string;
    traceId: string;
    decidedAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null>;
  completeCase(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    completedAt: Date;
    cooldownEndsAt: Date;
  }): Promise<AccountRecoveryCaseRecord | null>;
  /** Returns the still-active cooldown expiry for this account, or null if none applies right now. */
  getActiveCooldown(accountId: string, now: Date): Promise<Date | null>;
  /**
   * Customer recovery completion: revokes every active device on the account
   * (status "revoked", with when and why) and removes the account's
   * device_key login methods, in one transaction, auditing each revoked
   * device and the removal. Idempotent: a retry finds nothing left to do.
   */
  revokeDevicesForRecovery(input: {
    caseId: string;
    accountId: string;
    actorAccountId: string;
    traceId: string;
    revokedAt: Date;
  }): Promise<{ revokedDeviceIds: string[]; removedLoginMethodCount: number }>;
  /** Records one step of a recovery case in the audit log. */
  recordRecoveryAuditEvent(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    action: string;
    changes: Record<string, string | number | boolean | null>;
    occurredAt: Date;
  }): Promise<void>;
}
