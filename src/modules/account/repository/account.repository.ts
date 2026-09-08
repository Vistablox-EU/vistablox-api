export type AccountStatus = "active" | "recovery_review" | "suspended_restricted";
export type LoginMethodType = "passkey" | "google" | "apple";

export interface LocalAccountContext {
  accountId: string;
  status: AccountStatus;
}

export interface AccountRepository {
  findByBetterAuthUserId(betterAuthUserId: string): Promise<LocalAccountContext | null>;
  hasActiveStaffRole(
    accountId: string,
    role: "admin_operations" | "legal_partner" | "appraisal_partner",
  ): Promise<boolean>;
  hasAnyActiveStaffRole(accountId: string): Promise<boolean>;
  // The org id (legal_practice_id / appraisal_firm_id) tied to the account's
  // own active assignment of this role -- null if the role isn't currently
  // assigned. Org-level only, per AD-248: there is no named individual
  // reviewer field, so this is the whole "which organization is this
  // partner acting for" answer.
  getActivePartnerOrganizationId(
    accountId: string,
    role: "legal_partner" | "appraisal_partner",
  ): Promise<string | null>;
  provision(input: {
    betterAuthUserId: string;
    protectedContactEmail: string | null;
  }): Promise<LocalAccountContext>;
  syncVerifiedContactEmail(input: {
    betterAuthUserId: string;
    protectedContactEmail: string;
  }): Promise<void>;
  recordLoginMethod?(input: {
    betterAuthUserId: string;
    methodType: LoginMethodType;
    providerSubject: string;
    linkedAt: Date;
  }): Promise<void>;
}
