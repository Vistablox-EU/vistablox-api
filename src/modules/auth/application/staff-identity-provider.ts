export interface StaffIdentityProvider {
  assertEmailAvailable(email: string): Promise<void>;
  createOrResolveInvitedStaff(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<{ betterAuthUserId: string }>;
}
