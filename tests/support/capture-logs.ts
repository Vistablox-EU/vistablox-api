import { Writable } from "node:stream";

import pino from "pino";

export interface CapturedLogEntry {
  level: number;
  msg?: string;
  trace_id?: string;
  status?: number;
  code?: string;
  err?: { message?: string; type?: string; cause?: { message?: string; issues?: unknown }; issues?: unknown };
  [key: string]: unknown;
}

/** A real pino logger writing JSON lines to memory, so tests see exactly what a log pipeline would. */
export function captureLogs() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return {
    logger: pino({ level: "trace" }, destination),
    lines,
    entries: (): CapturedLogEntry[] => lines.map((line) => JSON.parse(line) as CapturedLogEntry),
  };
}
