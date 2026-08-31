import type { StaffOffboardingReason } from "../application/staff-account-administrator.js";

export interface StaffAccountLifecycleTarget {
  accountId: string;
  betterAuthUserId: string;
  status: string;
  hasActiveStaffRole: boolean;
}

export interface StaffAccountLifecycleRepository {
  findTarget(accountId: string): Promise<StaffAccountLifecycleTarget | null>;
  prepareRecovery(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    preparedAt: Date;
  }): Promise<boolean>;
  recordRecoveryDeliveryFailure(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    failedAt: Date;
  }): Promise<void>;
  completeOffboarding(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    reason: StaffOffboardingReason;
    completedAt: Date;
  }): Promise<void>;
}
