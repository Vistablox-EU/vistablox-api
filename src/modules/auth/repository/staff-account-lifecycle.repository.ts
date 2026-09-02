import type { StaffOffboardingReason } from "../application/staff-account-administrator.js";
import type { StaffRole } from "./staff-invitation.repository.js";

export interface StaffAccountLifecycleTarget {
  accountId: string;
  betterAuthUserId: string;
  status: string;
  hasActiveStaffRole: boolean;
}

export interface StaffRoleAssignmentRecord {
  assignmentId: string;
  role: StaffRole;
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
}

export interface StaffAccountRosterEntry {
  accountId: string;
  email: string | null;
  status: string;
  roles: StaffRoleAssignmentRecord[];
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
  listStaffAccounts(): Promise<StaffAccountRosterEntry[]>;
  hasActiveRole(input: { accountId: string; role: StaffRole }): Promise<boolean>;
  grantRole(input: {
    accountId: string;
    role: StaffRole;
    legalPracticeId: string | null;
    appraisalFirmId: string | null;
    actorAccountId: string;
    traceId: string;
    grantedAt: Date;
  }): Promise<StaffRoleAssignmentRecord>;
  revokeRole(input: {
    accountId: string;
    assignmentId: string;
    actorAccountId: string;
    traceId: string;
    revokedAt: Date;
  }): Promise<StaffRoleAssignmentRecord | null>;
}
