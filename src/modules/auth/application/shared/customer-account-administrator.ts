export interface CustomerAccountAdministrator {
  /** Kills every existing session for the target immediately — used when opening a full-lockout recovery case. */
  revokeAllSessions(betterAuthUserId: string): Promise<void>;
  /** Sends a short-lived link for replacement-passkey enrollment. */
  sendRecoveryCompletionEmail(input: {
    betterAuthUserId: string;
    redirectTo: string;
    traceId: string;
  }): Promise<void>;
  /** Revokes old access and returns a one-time context for replacing the passkey in-app. */
  prepareSelfServicePasskeyReplacement(betterAuthUserId: string): Promise<string>;
  /**
   * Customer recovery completion: ends every session the customer still has,
   * device sessions included, without touching the recovery flag. Returns how
   * many there were, and how many of them were device_biometric.
   */
  revokeSessionsForRecoveryCompletion(
    betterAuthUserId: string,
  ): Promise<{ revokedSessionCount: number; deviceSessionCount: number }>;
  /** Clears recoveryRequiredAt, so the customer can sign in with Google/Apple again. */
  clearRecoveryRequired(betterAuthUserId: string): Promise<void>;
}
