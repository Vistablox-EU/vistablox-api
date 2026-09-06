export interface CustomerSessionSummary {
  sessionId: string;
  channel: string;
  deviceLabel: string | null;
  authMethodAtLogin: string;
  createdAt: Date;
  lastSeenAt: Date;
  status: string;
  revocationReason: string | null;
  betterAuthSessionId: string | null;
}

export interface CustomerSessionRepository {
  listForAccount(accountId: string): Promise<CustomerSessionSummary[]>;
  /** Returns the session's Better Auth token, scoped to the caller's own account. */
  findOwnedSessionToken(accountId: string, sessionId: string): Promise<string | null>;
  hasFreshAuthentication?(input: {
    accountId: string;
    providerSessionId: string;
    freshAfter: Date;
  }): Promise<boolean>;
}
