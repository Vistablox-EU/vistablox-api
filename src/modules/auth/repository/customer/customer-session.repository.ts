import type { ProviderSessionFacts } from "../../domain/session-liveness.js";

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
  /**
   * Better-auth's own row for this session, or null when it has none (the row
   * is gone, or the mirror row has no provider session to look up). Only
   * looked up for rows still marked 'active'.
   */
  providerSession: ProviderSessionFacts | null;
}

export interface CustomerSessionRepository {
  listForAccount(accountId: string): Promise<CustomerSessionSummary[]>;
  /** Returns the Better Auth session ID, scoped to the caller's own account. */
  findOwnedProviderSessionId(accountId: string, sessionId: string): Promise<string | null>;
  hasFreshAuthentication?(input: {
    accountId: string;
    providerSessionId: string;
    freshAfter: Date;
  }): Promise<boolean>;
}
