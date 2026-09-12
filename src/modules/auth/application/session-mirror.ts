export interface RecordSessionCreatedInput {
  betterAuthUserId: string;
  betterAuthSessionId: string;
  betterAuthSessionToken: string;
  authMethodAtLogin: string | null;
  userAgent: string | null;
  createdAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface RecordSessionRevokedInput {
  betterAuthSessionId: string;
  revokedAt: Date;
  reason: string;
}

export interface RecordSessionActivityInput {
  betterAuthSessionId: string;
  seenAt: Date;
  idleExpiresAt: Date;
}

// Populates auth.sessions, the customer-facing mirror of Better Auth's
// own session table (SESSION_MODEL.md): richer display fields than Better
// Auth's generic session carries, and a self-service revoke surface. Better
// Auth's own session table remains the sole authority for whether a request
// is actually authenticated — this mirror is a display/self-service layer
// alongside it, not a replacement.
export interface SessionMirror {
  recordCreated(input: RecordSessionCreatedInput): Promise<void>;
  recordRevoked(input: RecordSessionRevokedInput): Promise<void>;
  // Device sessions only (they have an idle limit): moves last_seen_at and
  // idle_expires_at forward after a fully authenticated request. Optional
  // so existing implementations and test doubles stay valid.
  recordActivity?(input: RecordSessionActivityInput): Promise<void>;
}
