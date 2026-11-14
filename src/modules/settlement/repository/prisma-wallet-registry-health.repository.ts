import { z } from "zod";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  WalletRegistryHealthReader,
  WalletRegistryHealthReading,
  WalletRegistryHeartbeat,
  WalletRegistryHeartbeatWriter,
} from "./wallet-registry-health.repository.js";

// Same table and precedent as the watcher's cursor (prisma-settlement.repository.ts):
// a platform.settings row, so no migration. A separate row from the cursor, so
// the cursor's format is untouched and an older build keeps reading it.
const WALLET_REGISTRY_HEARTBEAT_SETTING_KEY = "wallet_registry.watcher_heartbeat";
const HEARTBEAT_VERSION = 1;
const MAX_LISTED_MISMATCH_ACCOUNTS = 20;

// Unknown keys are stripped, not rejected, so a later build can add a field
// without making this one read the row as missing.
const storedHeartbeatSchema = z.object({
  completed_at: z.iso.datetime(),
  cursor_block: z
    .string()
    .regex(/^\d+$/)
    .nullable(),
  safe_head_block: z.string().regex(/^\d+$/),
  events_found: z.number().int().min(0),
});

function parseHeartbeat(value: unknown): WalletRegistryHeartbeat | null {
  const parsed = storedHeartbeatSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    completedAt: new Date(parsed.data.completed_at),
    cursorBlock: parsed.data.cursor_block === null ? null : BigInt(parsed.data.cursor_block),
    safeHeadBlock: BigInt(parsed.data.safe_head_block),
    eventsFound: parsed.data.events_found,
  };
}

interface PendingAggregateRow {
  total: bigint;
  overdue: bigint;
  oldest: Date | null;
}

interface UnresolvedMismatchRow {
  total: bigint;
  account_id: string;
}

export class PrismaWalletRegistryHealthRepository
  implements WalletRegistryHeartbeatWriter, WalletRegistryHealthReader
{
  public constructor(private readonly database: DatabaseClient) {}

  public async recordWatcherHeartbeat(input: WalletRegistryHeartbeat): Promise<void> {
    const value = {
      version: HEARTBEAT_VERSION,
      completed_at: input.completedAt.toISOString(),
      cursor_block: input.cursorBlock === null ? null : input.cursorBlock.toString(),
      safe_head_block: input.safeHeadBlock.toString(),
      events_found: input.eventsFound,
    };
    await this.database.platformSetting.upsert({
      where: { key: WALLET_REGISTRY_HEARTBEAT_SETTING_KEY },
      create: {
        key: WALLET_REGISTRY_HEARTBEAT_SETTING_KEY,
        value,
        description:
          "When the VistaBloxWalletRegistry watcher last completed a run, and the cursor and safe head it saw then (health check input).",
      },
      update: { value, updatedAt: input.completedAt },
    });
  }

  public async readWalletRegistryHealth(overdueCutoff: Date): Promise<WalletRegistryHealthReading> {
    const [pending, unresolved, setting] = await Promise.all([
      this.database.$queryRaw<PendingAggregateRow[]>`
        SELECT count(*) AS total,
               count(*) FILTER (WHERE requested_at < ${overdueCutoff}::timestamptz) AS overdue,
               min(requested_at) AS oldest
        FROM settlement.wallet_registrations
        WHERE registered_at IS NULL
      `,
      // "Unresolved" means the account's CURRENT claim is still unconfirmed and
      // still carries the commitment the mismatching event named. A claim that
      // was confirmed, or replaced by a new commitment, is no longer open.
      // Legacy rows with no event_key count too: they are real mismatches.
      this.database.$queryRaw<UnresolvedMismatchRow[]>`
        WITH unresolved AS (
          SELECT a.resource_id AS account_id, min(a.created_at) AS first_seen
          FROM audit.audit_log a
          JOIN settlement.wallet_registrations w ON w.account_id = a.resource_id
          WHERE a.action = 'settlement.wallet_registration_address_mismatch'
            AND a.resource_type = 'wallet_registration'
            AND w.registered_at IS NULL
            AND lower(w.registration_commitment) = lower(a.changes ->> 'commitment')
          GROUP BY a.resource_id
        )
        SELECT count(*) OVER () AS total, account_id
        FROM unresolved
        ORDER BY first_seen, account_id
        LIMIT ${MAX_LISTED_MISMATCH_ACCOUNTS}
      `,
      this.database.platformSetting.findUnique({
        where: { key: WALLET_REGISTRY_HEARTBEAT_SETTING_KEY },
        select: { value: true },
      }),
    ]);

    const aggregate = pending[0];
    return {
      heartbeat: setting === null ? null : parseHeartbeat(setting.value),
      pendingTotal: Number(aggregate?.total ?? 0n),
      pendingOverdue: Number(aggregate?.overdue ?? 0n),
      oldestPendingRequestedAt: aggregate?.oldest ?? null,
      unresolvedMismatches: {
        count: Number(unresolved[0]?.total ?? 0n),
        accountIds: unresolved.map((row) => row.account_id),
      },
    };
  }
}
