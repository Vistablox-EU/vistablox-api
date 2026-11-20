import type { Logger } from "pino";

import { createLogger } from "../../src/infrastructure/logging/logger.js";

/**
 * The application's own logger (same redaction), writing every line it emits
 * into an array as the parsed JSON object. A test asserting on `lines` sees
 * what the log would actually contain, serializers included.
 */
export function createMemoryLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger("info", {
    write(chunk: string): void {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  });
  return { logger, lines };
}
