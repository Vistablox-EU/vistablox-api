export type StaffOffboardingReason =
  | "employment_ended"
  | "partner_firm_notice"
  | "security_action";

export interface StaffAccountAdministrator {
  prepareRecovery(input: {
    betterAuthUserId: string;
    recoveryRequiredAt: Date;
  }): Promise<void>;
  sendRecoveryEmail(input: {
    betterAuthUserId: string;
    redirectTo: string;
    traceId: string;
  }): Promise<void>;
  disableAndRevoke(input: {
    betterAuthUserId: string;
    reason: StaffOffboardingReason;
    disabledAt: Date;
  }): Promise<void>;
}
