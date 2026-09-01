import type { Pool } from "pg";
import type { Adapter, AdapterFactory, AdapterPayload } from "oidc-provider";

const TABLE = "oidc_model_instances";

interface StoredRow {
  payload: AdapterPayload;
  consumed_at: Date | null;
}

/**
 * oidc-provider's own persistent store, mirroring the storage pattern
 * better-auth uses: a raw `pg` Pool against a table outside Prisma's
 * managed schema (see the migration's header comment), not an in-memory
 * or otherwise VistaBlox-invisible store (SESSION_MODEL.md).
 *
 * One instance is constructed per oidc-provider model name; all instances
 * share the same underlying table, partitioned by `model_name`.
 */
export class PostgresOidcAdapter implements Adapter {
  public constructor(
    private readonly pool: Pool,
    private readonly modelName: string,
  ) {}

  public async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const expiresAt = typeof expiresIn === "number" ? new Date(Date.now() + expiresIn * 1000) : null;
    const grantId = typeof payload.grantId === "string" ? payload.grantId : null;
    const userCode = typeof payload.userCode === "string" ? payload.userCode : null;
    const uid = typeof payload.uid === "string" ? payload.uid : null;

    await this.pool.query(
      `INSERT INTO "${TABLE}"
         ("model_name", "id", "payload", "grant_id", "user_code", "uid", "expires_at", "consumed_at")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT ("model_name", "id") DO UPDATE SET
         "payload" = EXCLUDED."payload",
         "grant_id" = EXCLUDED."grant_id",
         "user_code" = EXCLUDED."user_code",
         "uid" = EXCLUDED."uid",
         "expires_at" = EXCLUDED."expires_at",
         "consumed_at" = NULL`,
      [this.modelName, id, payload, grantId, userCode, uid, expiresAt],
    );
  }

  public async find(id: string): Promise<AdapterPayload | undefined> {
    const result = await this.pool.query<StoredRow>(
      `SELECT "payload", "consumed_at" FROM "${TABLE}"
       WHERE "model_name" = $1 AND "id" = $2
         AND ("expires_at" IS NULL OR "expires_at" > now())`,
      [this.modelName, id],
    );
    return rowToPayload(result.rows[0]);
  }

  public async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const result = await this.pool.query<StoredRow>(
      `SELECT "payload", "consumed_at" FROM "${TABLE}"
       WHERE "model_name" = $1 AND "user_code" = $2
         AND ("expires_at" IS NULL OR "expires_at" > now())`,
      [this.modelName, userCode],
    );
    return rowToPayload(result.rows[0]);
  }

  public async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const result = await this.pool.query<StoredRow>(
      `SELECT "payload", "consumed_at" FROM "${TABLE}"
       WHERE "model_name" = $1 AND "uid" = $2
         AND ("expires_at" IS NULL OR "expires_at" > now())`,
      [this.modelName, uid],
    );
    return rowToPayload(result.rows[0]);
  }

  public async consume(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE "${TABLE}" SET "consumed_at" = now() WHERE "model_name" = $1 AND "id" = $2`,
      [this.modelName, id],
    );
  }

  public async destroy(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM "${TABLE}" WHERE "model_name" = $1 AND "id" = $2`, [
      this.modelName,
      id,
    ]);
  }

  public async revokeByGrantId(grantId: string): Promise<void> {
    await this.pool.query(`DELETE FROM "${TABLE}" WHERE "grant_id" = $1`, [grantId]);
  }
}

function rowToPayload(row: StoredRow | undefined): AdapterPayload | undefined {
  if (row === undefined) {
    return undefined;
  }
  if (row.consumed_at === null) {
    return row.payload;
  }
  return { ...row.payload, consumed: Math.floor(row.consumed_at.getTime() / 1000) };
}

export function createPostgresOidcAdapterFactory(pool: Pool): AdapterFactory {
  return (modelName: string) => new PostgresOidcAdapter(pool, modelName);
}
