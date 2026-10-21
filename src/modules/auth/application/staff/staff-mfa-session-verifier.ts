export interface StaffMfaSessionVerifier {
  isSessionVerified(accountId: string, providerSessionId: string): Promise<boolean>;
}
