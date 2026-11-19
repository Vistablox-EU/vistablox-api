import type { Logger } from "pino";
import { Pool, type PoolConfig } from "pg";

import { toSanitizedError } from "../../shared/logging/log-redaction.js";

/**
 * A pg Pool that survives the database dropping one of its idle connections.
 *
 * pg-pool re-emits an idle client's connection error as an "error" event on the
 * pool. The pool has already discarded that client and opens a fresh one on the
 * next request, so nothing needs repairing, but EventEmitter throws an "error"
 * event nobody listens for, and that ends the process. A database restart, a
 * failover or an idle-connection timeout on the server side is enough to
 * trigger it. This logs the event at error level and carries on.
 *
 * Use it instead of `new Pool(...)` for every pool the process owns.
 */
export function createPgPool(config: PoolConfig, logger: Pick<Logger, "error">, name: string): Pool {
  const pool = new Pool(config);
  pool.on("error", (error: Error) => {
    // The error is rebuilt rather than logged as-is: pg-pool attaches the dead
    // Client to it (`err.client`), and serialising that would put the backend
    // process id, the cancel secret key and the connection parameters in the log.
    const code = (error as { code?: unknown }).code;
    logger.error(
      { err: toSanitizedError(error), pool: name, ...(typeof code === "string" ? { pg_code: code } : {}) },
      "database pool idle client error",
    );
  });
  return pool;
}
