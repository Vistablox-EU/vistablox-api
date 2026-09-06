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
}
