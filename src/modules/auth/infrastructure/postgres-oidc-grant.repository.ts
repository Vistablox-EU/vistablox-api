import type { Pool } from "pg";

import type { OidcGrantRepository, OidcGrantSummary } from "../repository/oidc-grant.repository.js";

/**
 * oidc-provider's Grant model rows are keyed by the better-auth user id
 * (see findAccount in oidc-provider.factory.ts), not the local account_id,
 * so every query joins through account.accounts — the same "join Account
 * directly within the owning repository" pattern used elsewhere in this
 * module rather than widening a shared port interface.
 */
export class PostgresOidcGrantRepository implements OidcGrantRepository {
  public constructor(private readonly pool: Pool) {}

  public async listForAccount(accountId: string): Promise<OidcGrantSummary[]> {
    const result = await this.pool.query<{ id: string; created_at: Date }>(
      `SELECT g."id", g."created_at"
       FROM "oidc_model_instances" g
       JOIN "account"."accounts" a ON a."better_auth_user_id" = g."payload"->>'accountId'
       WHERE a."account_id" = $1
         AND g."model_name" = 'Grant'
         AND (g."expires_at" IS NULL OR g."expires_at" > now())
       ORDER BY g."created_at" DESC`,
      [accountId],
    );
    return result.rows.map((row) => ({
      grantId: row.id,
      createdAt: row.created_at,
      status: "active" as const,
    }));
  }

  public async isOwnedByAccount(accountId: string, grantId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM "oidc_model_instances" g
       JOIN "account"."accounts" a ON a."better_auth_user_id" = g."payload"->>'accountId'
       WHERE a."account_id" = $1
         AND g."model_name" = 'Grant'
         AND g."id" = $2
         AND (g."expires_at" IS NULL OR g."expires_at" > now())`,
      [accountId, grantId],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }

  public async revoke(grantId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM "oidc_model_instances"
       WHERE "grant_id" = $1 OR ("model_name" = 'Grant' AND "id" = $1)`,
      [grantId],
    );
  }
}
