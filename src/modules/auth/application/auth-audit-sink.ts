export interface AuthAuditEvent {
  eventKey: string;
  action: string;
  betterAuthUserId: string | null;
  // Set when the caller already has the local account_id in hand (e.g. from
  // an authenticated request context) so the sink can skip resolving it from
  // betterAuthUserId. Leave unset to resolve from betterAuthUserId as usual.
  accountId?: string;
  attributeToSubject: boolean;
  resourceType: "account" | "session" | "oidc_grant" | "login_attempt";
  resourceId: string;
  changes: Record<string, string | boolean | null>;
  occurredAt: Date;
}

export interface AuthAuditSink {
  record(event: AuthAuditEvent): Promise<void>;
}
