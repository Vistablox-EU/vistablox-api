import type { Pool } from "pg";

import type { OidcCleanupRepository } from "../repository/oidc-cleanup.repository.js";

export class PostgresOidcCleanupRepository implements OidcCleanupRepository {
  public constructor(private readonly pool: Pool) {}

  public async deleteExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM "oidc_model_instances" WHERE "expires_at" IS NOT NULL AND "expires_at" < now()`,
    );
    return result.rowCount ?? 0;
  }
}
