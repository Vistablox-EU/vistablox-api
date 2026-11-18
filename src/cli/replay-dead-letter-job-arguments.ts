import { parseArgs } from "node:util";

import { z } from "zod";

export const REPLAY_DEAD_LETTER_JOB_USAGE = `Usage:
  npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid>
  npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid> --confirm --operator <name>

Re-enqueues one dead-lettered job onto the queue it failed on, with its payload
unchanged (docs/dead-letter-jobs.md). Without --confirm it is a dry run: it
prints what would be replayed (queue, ids, owner, payload key names, never
payload values) and changes nothing. Only event queues are replayed; a
scheduled queue's next tick is its retry. Replaying the same entry twice is a
no-op. A confirmed replay writes one audit.audit_log row (action
job.dead_letter_replayed) in the same transaction as the send.

  --dead-letter-job-id  the dead_letter_job_id from the alert or log line (required)
  --confirm             send the job; without it nothing is changed
  --operator            who is replaying, recorded in the audit row (required with --confirm)
  --help                show this help`;

export type ReplayDeadLetterJobArguments =
  | { mode: "help" }
  | { mode: "dry_run"; deadLetterJobId: string; operator: string | null }
  | { mode: "confirm"; deadLetterJobId: string; operator: string };

export type ParsedReplayDeadLetterJobArguments =
  | { ok: true; value: ReplayDeadLetterJobArguments }
  | { ok: false; error: string };

export function parseReplayDeadLetterJobArguments(argv: string[]): ParsedReplayDeadLetterJobArguments {
  let values: { "dead-letter-job-id"?: string; confirm?: boolean; operator?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dead-letter-job-id": { type: "string" },
        confirm: { type: "boolean" },
        operator: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid arguments" };
  }

  if (values.help === true) return { ok: true, value: { mode: "help" } };
  const id = values["dead-letter-job-id"];
  if (id === undefined) return { ok: false, error: "--dead-letter-job-id is required" };
  const parsed = z.uuid().safeParse(id.trim().toLowerCase());
  if (!parsed.success) return { ok: false, error: "--dead-letter-job-id must be a UUID" };
  const operator = values.operator?.trim() ?? "";
  if (values.operator !== undefined && operator.length === 0) return { ok: false, error: "--operator must not be empty" };
  if (values.confirm === true) {
    if (operator.length === 0) return { ok: false, error: "--operator is required with --confirm" };
    return { ok: true, value: { mode: "confirm", deadLetterJobId: parsed.data, operator } };
  }
  return {
    ok: true,
    value: { mode: "dry_run", deadLetterJobId: parsed.data, operator: operator.length === 0 ? null : operator },
  };
}
