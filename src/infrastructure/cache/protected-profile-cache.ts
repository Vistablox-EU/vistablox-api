// Lives here, not under either module that uses it: identity (which fetches
// and caches this, in kyc-display-profile.service.ts) and investor-profile
// (which reads it through ProtectedDisplayProfileProvider) can't import
// from each other's application layer (no-cross-domain-internals).
export interface ProtectedDisplayProfile {
  givenName: string;
  familyName: string;
  fullDisplayName: string;
  syncedAt: Date;
}

export interface ProtectedProfileCache {
  get(accountId: string): Promise<ProtectedDisplayProfile | null>;
  set(accountId: string, profile: ProtectedDisplayProfile): Promise<void>;
  delete(accountId: string): Promise<void>;
}
