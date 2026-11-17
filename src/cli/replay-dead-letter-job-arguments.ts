import { parseArgs } from "node:util";

import { z } from "zod";

export const REPLAY_DEAD_LETTER_JOB_USAGE = `Usage:
  npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid>
  npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid> --confirm

Re-enqueues one dead-lettered job onto the queue it failed on, with its payload
unchanged (docs/dead-letter-jobs.md). Without --confirm it is a dry run: it
prints what would be replayed (queue, ids, owner, payload key names, never
payload values) and changes nothing. Only event queues are replayed; a
scheduled queue's next tick is its retry. Replaying the same entry twice is a
no-op.

  --dead-letter-job-id  the dead_letter_job_id from the alert or log line (required)
  --confirm             send the job; without it nothing is changed
  --help                show this help`;

export type ReplayDeadLetterJobArguments =
  | { mode: "help" }
  | { mode: "dry_run" | "confirm"; deadLetterJobId: string };

export type ParsedReplayDeadLetterJobArguments =
  | { ok: true; value: ReplayDeadLetterJobArguments }
  | { ok: false; error: string };

export function parseReplayDeadLetterJobArguments(argv: string[]): ParsedReplayDeadLetterJobArguments {
  let values: { "dead-letter-job-id"?: string; confirm?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dead-letter-job-id": { type: "string" },
        confirm: { type: "boolean" },
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
  return {
    ok: true,
    value: { mode: values.confirm === true ? "confirm" : "dry_run", deadLetterJobId: parsed.data },
  };
}
