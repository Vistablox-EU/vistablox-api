export type AccountStatus = "active" | "recovery_review" | "suspended_restricted";

export interface LocalAccountContext {
  accountId: string;
  status: AccountStatus;
}

export interface AccountRepository {
  findByBetterAuthUserId(betterAuthUserId: string): Promise<LocalAccountContext | null>;
  hasActiveStaffRole(accountId: string, role: "admin_operations"): Promise<boolean>;
  hasAnyActiveStaffRole(accountId: string): Promise<boolean>;
  provision(input: {
    betterAuthUserId: string;
    protectedContactEmail: string | null;
  }): Promise<LocalAccountContext>;
  syncVerifiedContactEmail(input: {
    betterAuthUserId: string;
    protectedContactEmail: string;
  }): Promise<void>;
}
