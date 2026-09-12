import { parseArgs } from "node:util";

import { z } from "zod";

export const BOOTSTRAP_FIRST_ADMIN_USAGE = `Usage:
  npm run staff:bootstrap-first-admin -- --email <email> --display-name <name>
  npm run staff:bootstrap-first-admin -- --check

Issues the one-time invitation for the first admin_operations staff member and
prints its accept URL once. Refuses (exit 1, no changes) if an active staff
account already holds admin_operations. Re-running before the invitation is
accepted revokes the earlier link and issues a new one.

  --email          the first admin's email address (required unless --check)
  --display-name   the first admin's display name (required unless --check)
  --check          read-only: print counts only, change nothing
  --help           show this help`;

// Same rules as the HTTP invitation body (staff-invitation.schemas.ts).
const issueArgumentsSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(1).max(200),
});

export type BootstrapFirstAdminArguments =
  | { mode: "help" }
  | { mode: "check" }
  | { mode: "issue"; email: string; displayName: string };

export type ParsedBootstrapArguments =
  | { ok: true; value: BootstrapFirstAdminArguments }
  | { ok: false; error: string };

export function parseBootstrapFirstAdminArguments(argv: string[]): ParsedBootstrapArguments {
  let values: { email?: string; "display-name"?: string; check?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        email: { type: "string" },
        "display-name": { type: "string" },
        check: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid arguments" };
  }

  if (values.help === true) return { ok: true, value: { mode: "help" } };
  if (values.check === true) {
    if (values.email !== undefined || values["display-name"] !== undefined) {
      return { ok: false, error: "--check takes no other options" };
    }
    return { ok: true, value: { mode: "check" } };
  }

  if (values.email === undefined) return { ok: false, error: "--email is required" };
  if (values["display-name"] === undefined) {
    return { ok: false, error: "--display-name is required" };
  }
  const parsed = issueArgumentsSchema.safeParse({
    email: values.email.trim(),
    displayName: values["display-name"],
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0] === "displayName" ? "--display-name" : "--email";
    return { ok: false, error: `${field}: ${issue?.message ?? "invalid value"}` };
  }
  return { ok: true, value: { mode: "issue", ...parsed.data } };
}
