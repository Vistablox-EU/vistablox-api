export interface AuthAuditEvent {
  eventKey: string;
  action: string;
  betterAuthUserId: string | null;
  attributeToSubject: boolean;
  resourceType: "account" | "session" | "login_attempt";
  resourceId: string;
  changes: Record<string, string | boolean | null>;
  occurredAt: Date;
}

export interface AuthAuditSink {
  record(event: AuthAuditEvent): Promise<void>;
}
