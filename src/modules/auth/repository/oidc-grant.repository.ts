export interface OidcGrantSummary {
  grantId: string;
  createdAt: Date;
  status: "active";
}

/**
 * The native half of SESSION_MODEL.md's unified session/grant store —
 * oidc-provider's own grant continuity, scoped to a single account.
 */
export interface OidcGrantRepository {
  listForAccount(accountId: string): Promise<OidcGrantSummary[]>;
  isOwnedByAccount(accountId: string, grantId: string): Promise<boolean>;
  revoke(grantId: string): Promise<void>;
}
