export interface CustomerAccountAdministrator {
  /** Kills every existing session for the target immediately — used when opening a full-lockout recovery case. */
  revokeAllSessions(betterAuthUserId: string): Promise<void>;
  /**
   * Sends a password-reset-style link that lets the customer establish a new
   * session bound to their existing account_id without needing one already —
   * the same primitive staff recovery uses (requestPasswordReset), which is
   * why full-lockout recovery requires email/password to have been one of
   * the two linked methods (AD-015's Recovery Readiness Requirement already
   * guarantees this for any financially active account).
   */
  sendRecoveryCompletionEmail(input: {
    betterAuthUserId: string;
    redirectTo: string;
    traceId: string;
  }): Promise<void>;
}
