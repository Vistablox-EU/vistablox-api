export interface StaffIdentityProvider {
  assertEmailAvailable(email: string): Promise<void>;
  createOrResolveInvitedStaff(input: {
    email: string;
    displayName: string;
  }): Promise<{ betterAuthUserId: string; passkeyRegistrationContext: string }>;
}
