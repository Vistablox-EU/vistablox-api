export interface OidcCleanupRepository {
  /** Deletes expired oidc_model_instances rows; returns the number removed. */
  deleteExpired(): Promise<number>;
}
