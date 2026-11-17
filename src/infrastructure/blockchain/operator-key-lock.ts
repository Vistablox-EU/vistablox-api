import type { DatabaseClient } from "../database/prisma.js";

/**
 * pg_advisory_xact_lock key serializing every chain write made with the
 * platform's operator key (CHAIN_OPERATOR_PRIVATE_KEY). Advisory locks are
 * per database, and one database serves one environment with one operator key,
 * so this one key covers every process that signs with it: the worker's
 * settlement jobs and the operator command that opens IPO escrow campaigns.
 * Any constant works as long as nothing else uses it; the neighbouring key
 * 7_311_040_001 is the first-admin bootstrap's (PrismaStaffBootstrapRepository),
 * so a new advisory lock takes the next number. Exported so the integration
 * test can hold it and prove a writer really waits.
 */
export const OPERATOR_KEY_ADVISORY_LOCK_KEY = 7_311_040_002;

/**
 * Serializes the sections of code that read the operator account's nonce, sign
 * and send a transaction with it.
 *
 * Two writers that run at the same moment (the finalizer in the worker and the
 * operator command, or two worker runs) would otherwise both read the same
 * pending nonce, and one of the two transactions would be rejected or would
 * replace the other. The finalizer's mint attempts pin their nonce, so a
 * collision there is not merely a wasted attempt: it is a mint that never
 * lands.
 *
 * What `run` covers is the section from reading the nonce up to the node
 * accepting the signed transaction: the callback returns once `write` has
 * returned the hash, so the next writer's "pending" nonce count includes it. It
 * does not cover waiting for the receipt, which can take minutes and needs no
 * exclusivity. A callback must therefore not wait for a receipt.
 */
export interface OperatorKeyLock {
  run<T>(section: () => Promise<T>): Promise<T>;
}

export interface PostgresOperatorKeyLockOptions {
  /** How long a section waits for another writer's lock before failing. */
  waitMs?: number;
  /**
   * The longest a section may hold the lock. The lock is released when the
   * surrounding transaction ends, so a section that runs longer loses its
   * exclusivity; the default is far above a node round trip with retries.
   */
  holdMs?: number;
}

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_HOLD_MS = 120_000;

export class OperatorKeyLockTimeoutError extends Error {
  public override readonly name = "OperatorKeyLockTimeoutError";
}

/**
 * Transaction-scoped (pg_advisory_xact_lock), like the repository's other
 * advisory lock: the lock is released when the transaction ends, whether the
 * section returned, threw, or the process died and Postgres dropped the
 * connection, so a crashed writer can never leave the operator key locked.
 * The transaction holds one pooled connection for as long as the section runs;
 * the section itself must not use that transaction.
 */
export class PostgresOperatorKeyLock implements OperatorKeyLock {
  private readonly waitMs: number;
  private readonly holdMs: number;

  public constructor(
    private readonly database: Pick<DatabaseClient, "$transaction">,
    options: PostgresOperatorKeyLockOptions = {},
  ) {
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  }

  public async run<T>(section: () => Promise<T>): Promise<T> {
    let acquired = false;
    try {
      return await this.database.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '${Math.trunc(this.waitMs)}ms'`);
          await transaction.$queryRaw`
            SELECT 1 AS locked FROM pg_advisory_xact_lock(${OPERATOR_KEY_ADVISORY_LOCK_KEY}::bigint)
          `;
          acquired = true;
          return section();
        },
        { maxWait: 10_000, timeout: this.waitMs + this.holdMs },
      );
    } catch (error) {
      if (!acquired) {
        throw new OperatorKeyLockTimeoutError(
          `could not take the operator-key lock within ${this.waitMs} ms: ` +
            (error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
      throw error;
    }
  }
}
