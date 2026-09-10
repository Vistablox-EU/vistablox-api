import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { DpopReplayRepository } from "./dpop-replay.repository.js";

export class PrismaDpopReplayRepository implements DpopReplayRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async recordProof(jkt: string, jti: string, expiresAt: Date): Promise<boolean> {
    // ON CONFLICT DO NOTHING + RETURNING is the atomic "insert or tell me it
    // was already there" primitive Prisma's typed API doesn't offer -- a
    // plain create() + catching a unique-constraint error works too, but
    // this avoids relying on an exception for an expected, hot-path outcome.
    const inserted = await this.database.$queryRaw<Array<{ jkt: string }>>`
      INSERT INTO auth.dpop_replays (jkt, jti, expires_at)
      VALUES (${jkt}, ${jti}, ${expiresAt})
      ON CONFLICT (jkt, jti) DO NOTHING
      RETURNING jkt
    `;
    return inserted.length > 0;
  }

  public async pruneExpired(now: Date): Promise<number> {
    const result = await this.database.dpopReplay.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
