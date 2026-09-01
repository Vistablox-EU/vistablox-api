import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import type { OidcCleanupRepository } from "../repository/oidc-cleanup.repository.js";

// Without this sweep, oidc_model_instances would grow unboundedly — every
// authorization code, access token, and refresh token is a row, and
// Postgres has no native TTL. A single bulk delete has no separate
// "checked" count, so checked and acted both report the deleted total.
export class RunOidcCleanupService {
  public constructor(private readonly repository: OidcCleanupRepository) {}

  public async execute(): Promise<JobRunSummary> {
    const deleted = await this.repository.deleteExpired();
    return { checked: deleted, acted: deleted };
  }
}
