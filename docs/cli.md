# Command-line tools and npm scripts

Valid for main at 48aa967 (2026-11-18).

Every operator command in `src/cli` and every script in `package.json`: what it is for, its arguments and defaults, the environment it needs, what it reads and writes, how far it is safe to run, its exit codes, and how to run it in the staging containers. The readers are the engineer or operator who runs a command, and the reviewer who has to know what a command can change. The worker's own behaviour is in [jobs-and-workers.md](jobs-and-workers.md); the runbook for a dead-lettered job is [dead-letter-jobs.md](dead-letter-jobs.md).

Citations are `(path:line)` at 48aa967; the identifier is named next to the number because line numbers drift. A path that starts with `node_modules/` is library code read from an installed copy at the version `package-lock.json` locks; it is outside the repository. A statement marked `Not verified` could not be checked; the list is in [Not verified](#12-not-verified). A line that starts with `> Pending #N:` says what an open pull request changes in the statement above it; nothing under such a line is built on main.

Contents: [1 Overview](#1-overview) · [2 Safety by environment](#2-safety-by-environment) · [3 Operator commands](#3-operator-commands) · [4 Run and build scripts](#4-run-and-build-scripts) · [5 Check and test scripts](#5-check-and-test-scripts) · [6 Database scripts](#6-database-scripts) · [7 Contracts scripts](#7-contracts-scripts) · [8 Entry points that are not npm scripts](#8-entry-points-that-are-not-npm-scripts) · [9 Running a command in the staging containers](#9-running-a-command-in-the-staging-containers) · [10 Known limitations](#10-known-limitations) · [11 Related documents](#11-related-documents) · [12 Not verified](#12-not-verified)

## 1. Overview

`package.json` defines 21 scripts (`package.json:9-31`). Four of them start an operator command that is compiled into `dist/cli/`; the others run the servers, the checks, the database tooling or the contracts package. Arguments reach a script after a `--`: `npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid>`.

> Pending #225: adds one script, `clamav:smoke`, to `package.json`, so the count of 21 changes.

```mermaid
flowchart LR
  subgraph checkout["repository checkout with dev dependencies"]
    dev["dev, worker:dev, typecheck, architecture, test, test:watch, check, db:generate, db:validate, db:migrate:dev, contracts:*"]
    build["build: prisma generate, then tsc into dist/"]
  end
  subgraph image["api and worker images: dist, package.json, production node_modules"]
    ops["staff:bootstrap-first-admin<br/>intake:backfill-events<br/>jobs:replay-dead-letter<br/>settlement:open-ipo-escrow-campaigns"]
    serve["start, worker:start"]
  end
  mig["migrate image: full dependencies"] --> deploy["db:migrate:deploy"]
  build --> image
```

The `api` and `worker` images hold only `dist/`, `package.json` and the production dependencies (`Dockerfile:31-38`, `Dockerfile:42-48`). The scripts that need `tsx`, `vitest`, `tsc`, the Prisma CLI, `dependency-cruiser` or Hardhat therefore run in a checkout, not in those images; the four operator commands run from the compiled files, so they run in the images. The `migrate` image is built from the `build` stage and runs `npm run db:migrate:deploy` (`Dockerfile:27-28`).

| Script | Command | Where it runs | Effect |
| --- | --- | --- | --- |
| `dev` | `tsx watch src/server.ts` | checkout | api in watch mode (`package.json:10`) |
| `worker:dev` | `tsx watch src/worker.ts` | checkout | worker in watch mode (`:11`) |
| `build` | `npm run db:generate && tsc -p tsconfig.build.json` | checkout, Docker `build` stage | writes `src/generated/prisma` and `dist/` (`:12`) |
| `start` | `node dist/server.js` | image `api`, checkout after `build` | api (`:13`) |
| `worker:start` | `node dist/worker.js` | image `worker`, checkout after `build` | worker (`:14`) |
| `staff:bootstrap-first-admin` | `node dist/cli/bootstrap-first-admin.js` | image `api` | section 3.1 (`:15`) |
| `intake:backfill-events` | `node dist/cli/backfill-intake-case-events.js` | an image | section 3.2 (`:16`) |
| `jobs:replay-dead-letter` | `node dist/cli/replay-dead-letter-job.js` | image `worker` | section 3.3 (`:17`) |
| `settlement:open-ipo-escrow-campaigns` | `node dist/cli/open-ipo-escrow-campaigns.js` | image `worker` | section 3.4 (`:18`) |
| `typecheck` | `tsc --noEmit` | checkout | no output files (`:19`) |
| `test` | `vitest run` | checkout | tests (`:20`) |
| `test:watch` | `vitest` | checkout | tests in watch mode (`:21`) |
| `architecture` | `depcruise src --config dependency-cruiser.config.cjs` | checkout | dependency rules (`:22`) |
| `check` | `npm run typecheck && npm run architecture && npm test` | checkout, CI | all three (`:23`) |
| `db:generate` | `prisma generate` | checkout, Docker `build` stage | writes `src/generated/prisma` (`:24`) |
| `db:validate` | `prisma validate` | checkout | validates the schema (`:25`) |
| `db:migrate:dev` | `prisma migrate dev` | local database only | creates and applies a migration (`:26`) |
| `db:migrate:deploy` | `prisma migrate deploy` | `migrate` image, CI, local test database | applies the migrations that exist (`:27`) |
| `contracts:compile` | `npm --prefix contracts run compile` | checkout, CI | writes `contracts/artifacts` and `contracts/cache` (`:28`) |
| `contracts:test` | `npm --prefix contracts test` | checkout, CI | Hardhat tests (`:29`) |
| `contracts:export-abi` | `node scripts/export-contract-abis.mjs` | checkout, CI | writes three ABI files under `src` (`:30`) |

> Pending #225: a new script `npm run clamav:smoke` is added for the ClamAV scanner.

## 2. Safety by environment

No command checks `NODE_ENV` or `APP_ENV` to decide whether it may run. The one environment guard in the commands is the refusal of `settlement:open-ipo-escrow-campaigns` unless `CHAIN_NETWORK` is `base-sepolia` (section 3.4); `NODE_ENV` appears in `src/cli` once, to set secure cookies in the bootstrap command (`src/cli/bootstrap-first-admin.ts:74`). What the rules below add comes from `AGENTS.md` and the design record, not from the code.

| Command | Local | Staging | Production |
| --- | --- | --- | --- |
| `staff:bootstrap-first-admin` | against a local database | in the `vistablox-api` container | refuses by itself when an active `admin_operations` holder exists; no other guard |
| `intake:backfill-events` | against a local database | in an `api` or `worker` container | writes to whatever `DATABASE_URL` names; no guard |
| `jobs:replay-dead-letter` | against a local database that has the `pgboss` schema | in the `worker` container | dry run by default; `--confirm` sends; no other guard |
| `settlement:open-ipo-escrow-campaigns` | only with a `base-sepolia` bundle | in the `worker` container, where the `CHAIN_*` settings are | refuses on any other `CHAIN_NETWORK`, including `base` |
| `db:migrate:dev` | yes | never | never; `AGENTS.md` says local databases only |
| `db:migrate:deploy` | a local database only, including the local test database | run by the `migrate` service against the compose database (`docker-compose.staging.yml:96-111`) | `AGENTS.md`: never against anything but a local database; Neon is production-only (AD-257) |
| `contracts:*` | yes | not applicable | not applicable |

Three facts the table rests on. First, `AGENTS.md` states: "`npm run db:migrate:dev` is for local databases only. Never run `db:migrate:deploy` against anything but a local database. Neon is production-only (AD-257)." Second, `prisma.config.ts` takes the migration connection from `DIRECT_DATABASE_URL` and falls back to `postgresql://prisma:prisma@localhost:5432/vistablox` when it is unset (`prisma.config.ts:4-6`), so the safety of a migration command rests on what that variable holds in the shell that runs it; no code compares it with the local host. Third, no test helper checks that `TEST_DATABASE_URL` is local (searched `tests` for a host check: none).

Staging runs with `NODE_ENV=production` and marks itself with `APP_ENV=staging` (`Dockerfile:44`, `docker-compose.staging.yml:154`); a relaxation meant for staging keys on `APP_ENV`, and an unset `APP_ENV` is production (`AGENTS.md`).

## 3. Operator commands

All four commands load `.env` from the working directory when one exists (`import "dotenv/config"`) and then call `loadEnvironment()`, which parses the whole environment schema, so each needs a complete, valid API environment even when it uses a few variables (`src/cli/bootstrap-first-admin.ts:63`, `src/cli/replay-dead-letter-job.ts:46`, `src/cli/open-ipo-escrow-campaigns.ts:59`, `src/cli/backfill-intake-case-events.ts:50`). Inside a container that environment is already there. Three of the four print a usage text on `--help`, exit with 0 for success and with 1 for a refusal or failure, and with 2 for bad arguments; the exception is the backfill (section 3.2). In the three commands that parse arguments, a parse failure of the environment is thrown outside every `try`, so it ends the process with exit code 1 and the error's stack trace on standard error (a rejected top-level `await`, the same mechanism as the worker, [jobs-and-workers.md](jobs-and-workers.md) section 2.1). In the backfill the call sits inside `main()`, whose rejection is caught by the final `.catch`, so the same failure prints `Intake history backfill failed: <message>` and sets exit code 1 (`src/cli/backfill-intake-case-events.ts:50`, `:105-108`).

### 3.1 `staff:bootstrap-first-admin`

Issues the one-time invitation for the first `admin_operations` staff member and prints its accept URL once. There is deliberately no HTTP equivalent: a first-admin endpoint would let whoever reached it first become admin, and only someone with shell access to the running API container can run this (`src/cli/bootstrap-first-admin.ts:9-12`). The staff access model is in [staff-access.md](staff-access.md).

```text
npm run staff:bootstrap-first-admin -- --email <email> --display-name <name>
npm run staff:bootstrap-first-admin -- --check
npm run staff:bootstrap-first-admin -- --help
```

| Argument | Rule | Default |
| --- | --- | --- |
| `--email <email>` | required unless `--check` or `--help`; a valid email address, trimmed and lowercased (`src/cli/bootstrap-first-admin-arguments.ts:20-23`, `:60`) | none |
| `--display-name <name>` | required unless `--check` or `--help`; trimmed, 1 to 200 characters (`:22`, `:61-63`) | none |
| `--check` | read-only; takes no other option (`:53-58`) | off |
| `--help` | prints the usage text and exits 0 (`:52`) | off |

Unknown options and positional arguments are errors (`strict: true`, `allowPositionals: false`, `:45-46`) and end with exit code 2 and the usage text on standard error (`src/cli/bootstrap-first-admin.ts:52-57`).

**Environment.** The whole schema, in practice `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `AUTH_TRUSTED_ORIGINS`, `NODE_ENV` (secure cookies), the `SMTP_*` settings, the WebAuthn settings and the optional `STAFF_INVITATION_ACCEPT_URL`, which decides where the link points; it falls back to `/staff/accept-invitation` on the host of `BETTER_AUTH_URL` (`src/config/environment.ts:658-666`, `src/cli/bootstrap-first-admin.ts:70-92`).

**`--check`** prints three counts and whether the bootstrap would be refused, and changes nothing: active staff accounts, active `admin_operations` holders, and pending unexpired bootstrap invitations (`src/cli/bootstrap-first-admin.ts:94-106`, `src/modules/auth/repository/staff/prisma-staff-bootstrap.repository.ts:26-43`).

**Issuing** runs these steps (`src/modules/auth/application/staff/staff-bootstrap.service.ts:55-112`):

1. Counts the active `admin_operations` holders; one or more refuses with exit code 1 and changes nothing (`:66-67`).
2. Asks Better Auth whether the email already belongs to any identity, customer or staff; a refusal is printed as `Failed: <code>: <message>` with exit code 1 (`:71`, `src/cli/bootstrap-first-admin.ts:147-155`).
3. Generates a token, keeps only its SHA-256 hash, and in one transaction takes `pg_advisory_xact_lock(7311040001)` with a 15 s lock timeout, row-locks every live invitation that is a bootstrap invitation or has the same email, recounts the admins, revokes each live invitation with an audit row `authentication.staff_invitation_revoked` (reason `bootstrap_reissued` or `superseded_by_bootstrap`), inserts the invitation for role `admin_operations` with `issued_via = 'cli_bootstrap'` into `auth.staff_invitations`, and writes the audit row `authentication.staff_bootstrap_invitation_issued` (`src/modules/auth/repository/staff/prisma-staff-bootstrap.repository.ts:15-21`, `:45-151`).
4. Sends the invitation email on a best-effort basis; a failure is printed as `Invitation email could NOT be sent (<code>)` and does not fail the run (`staff-bootstrap.service.ts:86-100`).
5. Prints the invitation id, the role, the expiry, a trace id `cli_bootstrap_<uuid>` and the accept URL (`src/cli/bootstrap-first-admin.ts:108-145`).

The invitation lives 72 hours (`STAFF_INVITATION_LIFETIME_MS`, `src/modules/auth/application/staff/staff-invitation.service.ts:9`); the link carries the token as the query parameter `token` (`:143-146`). The URL is shown once and is neither stored nor logged; treat it like a password.

**Safety and repetition.** A second run before the invitation is accepted revokes the earlier bootstrap link and issues a new one, and it also revokes a pending staff-issued invitation for the same email. A second run after an admin exists is refused. Two runs at once are serialised by the advisory lock, and the second waits up to 15 s.

**Exit codes.** 0 done, `--check` done, or `--help`; 1 refused because an active admin exists, or failed; 2 bad arguments (`src/cli/bootstrap-first-admin.ts:1-16`).

**Run it in staging.**

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml exec vistablox-api \
  npm run staff:bootstrap-first-admin -- --check
docker compose --env-file .env.staging -f docker-compose.staging.yml exec vistablox-api \
  npm run staff:bootstrap-first-admin -- --email <email> --display-name "<name>"
```

### 3.2 `intake:backfill-events`

Imports the recoverable intake-case audit history into the immutable case-event ledger `intake.intake_case_events`. It is meant to run after the ledger migration `20260918120000_intake_case_event_ledger` and before the admin history tab is enabled (`src/cli/backfill-intake-case-events.ts:1-6`).

```text
npm run intake:backfill-events
```

**Arguments.** None. The file never reads `process.argv`, so every argument, `--help` included, is ignored and the import runs.

**Environment.** The whole schema, of which only `DATABASE_URL` is used (`src/cli/backfill-intake-case-events.ts:50`).

**What it does.** It reads every row of `audit.audit_log` whose `resource_type` is `intake_case` or `offering`, oldest first, in one query without paging (`:52-56`). It maps 16 intake audit actions (`intake.case_draft_created` to `intake.case_appraisal_recorded`) and 4 offering actions (`offering.opened_for_approved_case`, `offering.disclosure_pack_published`, `offering.final_terms_published`, `offering.finalized`) to event types (`:23-39`, `:60-65`); every other row is skipped and counted. For each mapped row it opens one transaction, finds the case id (for an offering row through the offering and its PIV), skips the row silently when the case or offering no longer exists (`:77-79`), and calls `appendIntakeCaseEvent` with the event key `legacy:audit:<audit row id>`, the source `legacy_audit`, workflow version 0 and metadata cut down to a list of allowed keys (`:42-47`, `:73-96`).

**Idempotence.** `appendIntakeCaseEvent` returns the existing event when the key exists and otherwise increments the case's `workflow_event_sequence` and inserts the row (`src/modules/intake/repository/intake-case-event.repository.ts:34-42`, `:64-102`), so a second run inserts nothing. A new event takes the next sequence number at the time it is imported; its `occurred_at` stays the audit row's time.

**Output and exit codes.** One line, `Imported <N> intake audit events; skipped <M> unmapped rows.` on standard output (`:99`). `N` counts every mapped row handled, including a row that already had its event and a row skipped because its case is gone, because the counter moves after the transaction whichever way it ended (`:73-97`). Exit code 0 on success; on an error the message `Intake history backfill failed: ...` goes to standard error and the exit code is 1 (`:105-107`).

**Safety.** It writes, it has no dry run and no confirmation flag, and it reads all matching audit rows into memory. It is safe to repeat. Run it in a container of the environment whose database is to change.

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml exec vistablox-api \
  npm run intake:backfill-events
```

### 3.3 `jobs:replay-dead-letter`

Sends one dead-lettered job back to the queue it failed on, with its payload unchanged. The triage that decides whether to replay is in [dead-letter-jobs.md](dead-letter-jobs.md); the mechanism is in [jobs-and-workers.md](jobs-and-workers.md) section 6.4.

```text
npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid>             (dry run)
npm run jobs:replay-dead-letter -- --dead-letter-job-id <uuid> --confirm
npm run jobs:replay-dead-letter -- --help
```

| Argument | Rule | Default |
| --- | --- | --- |
| `--dead-letter-job-id <uuid>` | required unless `--help`; trimmed, lowercased, must be a UUID; the `dead_letter_job_id` of the alert or the log line (`src/cli/replay-dead-letter-job-arguments.ts:46-49`) | none |
| `--confirm` | sends the job; without it nothing changes (`:52`) | dry run |
| `--help` | prints the usage text and exits 0 (`:45`) | off |

Unknown options and positional arguments are errors and end with exit code 2 (`:38-39`, `src/cli/replay-dead-letter-job.ts:34-39`).

**Environment.** The whole schema; the command uses `DATABASE_URL` and `LOG_LEVEL`. It builds a pg-boss instance with `supervise`, `schedule`, `migrate` and `createSchema` all off, so the `pgboss` schema must already exist and the command neither runs maintenance nor sends cron ticks (`src/cli/replay-dead-letter-job.ts:50-59`).

**What it does.** `planDeadLetterReplay` reads the entry and refuses for one of five reasons (`not_found`, `no_source`, `unknown_queue`, `scheduled_queue`, `already_replayed`; the table is in [jobs-and-workers.md](jobs-and-workers.md) section 6.4). A plan is printed: queue, owner and tier, dead-letter job id, the original job id, attempts so far, the payload's key names and never its values, and the replay job id (`src/cli/replay-dead-letter-job.ts:60-72`). A dry run stops there with `Re-run with --confirm to send it.` and exit code 0 (`:73-77`). With `--confirm` it sends the payload to the source queue as a new job with the event retry profile, a `deleteAfterSeconds` of 30 days and an id derived from the entry's id, then logs `job.dead_letter_replayed` at `warn` to standard error and prints `Sent as <queue> job <id>` (`:78-95`, `src/shared/jobs/dead-letter-replay.ts:115-126`).

**Safety.** Replaying runs the same handler on the same payload, so fix the cause first. Each entry can be replayed once: a second run, or a concurrent one, ends with `Refused (already_replayed)` and exit code 1 (`:61-64` when the plan finds the job, `:79-82` when the send finds it). Only event queues are replayed. The consumers' known replay hazards are in [dead-letter-jobs.md](dead-letter-jobs.md), "What makes it safe", and in [jobs-and-workers.md](jobs-and-workers.md) section 4.2.

> Pending #233: a confirmed replay writes an audit row in the same transaction as the send, and `--operator` becomes a mandatory argument together with `--confirm`.

**Exit codes.** 0 dry run, replay sent, or `--help`; 1 refused or failed; 2 bad arguments (`src/cli/replay-dead-letter-job.ts:1-12`, `:22-23`).

**Run it in staging.**

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker \
  npm run jobs:replay-dead-letter -- --dead-letter-job-id <dead_letter_job_id>
docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker \
  npm run jobs:replay-dead-letter -- --dead-letter-job-id <dead_letter_job_id> --confirm
```

### 3.4 `settlement:open-ipo-escrow-campaigns`

Opens the IPO escrow campaign of every offering that is still open for reservations and has an IPO deadline ahead, and records what the chain shows; that record is what lets such an offering take reservations. It signs `openCampaign` transactions with the platform's operator key, `CHAIN_OPERATOR_PRIVATE_KEY`, which is the platform's own wallet and not a user's key (`src/cli/open-ipo-escrow-campaigns-arguments.ts:3-28`, `AGENTS.md`). The flow around it is in [investor-offering.md](investor-offering.md).

```text
npm run settlement:open-ipo-escrow-campaigns                 (dry run)
npm run settlement:open-ipo-escrow-campaigns -- --confirm
npm run settlement:open-ipo-escrow-campaigns -- --help
```

| Argument | Rule | Default |
| --- | --- | --- |
| `--confirm` | opens the campaigns; sends transactions signed by the operator key (`src/cli/open-ipo-escrow-campaigns-arguments.ts:42`, `:53`) | dry run |
| `--help` | prints the usage text and exits 0 (`:52`) | off |

Unknown options and positional arguments are errors and end with exit code 2 (`:45-50`, `src/cli/open-ipo-escrow-campaigns.ts:47-51`).

**Environment.** The settlement bundle: `CHAIN_NETWORK`, `CHAIN_RPC_URL`, `CHAIN_OPERATOR_PRIVATE_KEY`, `VISTABLOX_PROPERTY_CONTRACT_ADDRESS`, `VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS`, `EURC_TOKEN_ADDRESS` and `PIV_TREASURY_ADDRESS`, plus `DATABASE_URL` and `LOG_LEVEL`. The command refuses before it opens a database connection or a chain client when the bundle is not complete, or when `CHAIN_NETWORK` is anything but `base-sepolia`; it prints `Refused (settlement_bundle_not_configured)` or `Refused (not_testnet)` with the reason to standard error and exits with 1 (`src/modules/settlement/application/open-ipo-escrow-campaigns-command.service.ts:40-62`, `src/modules/settlement/domain/ipo-escrow-campaign.policy.ts:168-204`, `src/infrastructure/blockchain/settlement-bundle.ts:24-34`). Every campaign gets the single `PIV_TREASURY_ADDRESS` as its treasury; the per-PIV treasury is not decided.

**Which offerings.** One row per PIV with an offering in status `pre_offering` whose final terms are not published, a token id, and an `ipo_end_at` in the future (`src/modules/settlement/repository/prisma-settlement.repository.ts:212-241`). The target is the offering's target raise in EURC base units and the deadline is `ipo_end_at` in Unix seconds, the same values the handoff job uses (`open-ipo-escrow-campaigns-command.service.ts:191-200`).

**What it does.** Offerings are handled one at a time and an error on one does not stop the next (`:144-161`). A dry run reads the chain (`campaignOf`) and the database and writes nothing. With `--confirm` each offering ends in one of these states:

| Status | Meaning | Counts as needing attention |
| --- | --- | --- |
| `would_open`, `opened` | no campaign on chain; it is (or would be) opened, `opened` with the transaction hash | no |
| `would_record`, `recorded` | already open with the offering's target, deadline, treasury and escrow contract; the observation is (or would be) recorded or refreshed | no |
| `refused_mismatch` | open with other parameters, or the stored observation was recorded for another escrow contract; not adopted and not replaced | yes |
| `resolved_on_chain` | `Successful` or `Failed` while the offering still takes reservations; it cannot be reopened | yes |
| `failed` | the attempt threw (an RPC error, a reverted transaction); logged as `settlement.ipo_escrow_campaign_open_failed` | yes |

(`open-ipo-escrow-campaigns-command.service.ts:64-117`, `:163-189`.) Opening sends the transaction under the operator-key advisory lock, waits for the receipt (viem's default wait is 180 s, `node_modules/viem/_esm/actions/public/waitForTransactionReceipt.js:53`), re-reads the campaign and upserts the observation into `settlement.ipo_escrow_campaigns` (`src/modules/settlement/application/open-ipo-escrow-campaign.service.ts:201-241`, `src/modules/settlement/repository/prisma-settlement.repository.ts:265-288`). The command shares the lock with the worker's finalizer and its campaign job, so they cannot take the same nonce (`src/infrastructure/blockchain/operator-key-lock.ts:16-37`).

**Output.** A header with the chain, the escrow address, the treasury and the number of offerings, then one line per offering and, when any needs attention, `N offering(s) failed or need manual action (marked above). Exit code 1.` A dry run ends with `Re-run with --confirm to open them.` (`open-ipo-escrow-campaigns-command.service.ts:242-314`).

**Exit codes.** 0 help, nothing to do, or every offering fine; 1 refused at startup, any offering failed or needs manual action, or an unexpected error; 2 bad arguments (`src/cli/open-ipo-escrow-campaigns.ts:1-15`, `:90-93`, `src/modules/settlement/application/open-ipo-escrow-campaigns-command.service.ts:155-160`).

**Safety.** Run the dry run first and read each offering's line. The transactions spend gas from the operator wallet. A campaign that exists with other parameters is never adopted, and a `refused_mismatch` or `resolved_on_chain` line needs a person; the manual step for a redeploy is in [investor-offering.md](investor-offering.md). The worker's `settlement.open_ipo_escrow_campaign` job runs the same service and is not limited to a testnet (`src/worker.ts:710-733`); only this command is.

**Run it in staging**, where the worker container holds the `CHAIN_*` settings when `.env.staging` provides them (`docker-compose.staging.yml:203-209`):

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker \
  npm run settlement:open-ipo-escrow-campaigns
docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker \
  npm run settlement:open-ipo-escrow-campaigns -- --confirm
```

## 4. Run and build scripts

| Script | Purpose and requirements |
| --- | --- |
| `dev` | Runs `src/server.ts` with `tsx watch` (`package.json:10`). Needs a valid `.env` with the whole schema and a PostgreSQL database; the api listens on `HOST` (default `0.0.0.0`) and `PORT` (default 3000) (`src/config/environment.ts:9-10`). Local use. |
| `worker:dev` | Runs `src/worker.ts` with `tsx watch` (`:11`). Same environment, and the worker's health listener takes `127.0.0.1:3001`, so a second worker on the same machine fails at boot (`src/shared/health/worker-heartbeat.ts:59-65`). Local use. |
| `build` | `npm run db:generate`, then `tsc -p tsconfig.build.json` (`:12`). The build config compiles `src/**/*.ts` without `src/**/*.test.ts` into `dist/` with source maps and declarations (`tsconfig.build.json:1-11`). The Docker `build` stage runs it with no database reachable (`Dockerfile:12-17`). |
| `start` | `node dist/server.js` (`:13`); needs a built `dist/`. This is the command of the `api` image (`Dockerfile:38`). |
| `worker:start` | `node dist/worker.js` (`:14`); needs a built `dist/`. The command of the `worker` image (`Dockerfile:48`). |

`dist/` and `src/generated/prisma/` are not tracked (`.gitignore:2`, `.gitignore:7`). The worker's boot, shutdown and variables are in [jobs-and-workers.md](jobs-and-workers.md).

## 5. Check and test scripts

| Script | What it does | Notes |
| --- | --- | --- |
| `typecheck` | `tsc --noEmit` over `src`, `tests`, `prisma.config.ts` and `vitest.config.ts` (`tsconfig.json:16`) | `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on (`tsconfig.json:7-9`). It needs the generated Prisma client, so run `npm run db:generate` first; CI does (`.github/workflows/ci.yml:63-64`). |
| `architecture` | `depcruise src --config dependency-cruiser.config.cjs` | Four rules, all errors: `routes-must-not-import-repositories`, `domain-must-stay-pure`, `no-cross-domain-internals`, `no-circular` (`dependency-cruiser.config.cjs:3-26`). |
| `test` | `vitest run` | Unit tests always run. Each `tests/*.integration.test.ts` file skips itself when `TEST_DATABASE_URL` is unset (`README.md`, "Testing"). Say so when a result was produced without it. |
| `test:watch` | `vitest` | Same, in watch mode. |
| `check` | `typecheck`, then `architecture`, then `test`, stopping at the first failure | `AGENTS.md`: run it before calling a change done. |

`TEST_DATABASE_URL` must name a local PostgreSQL 18 database that is separate from `DATABASE_URL`, because the integration tests create and delete real rows; its schema is created by applying the migrations to it with `DIRECT_DATABASE_URL` set to the same database (`README.md`, "Testing"; `.env.example:289-292`). Nothing in the code checks that the URL is local. Vitest runs the files in parallel against that one database, except two suites that run alone after the others, the wallet claim expiry suite and then the first-admin bootstrap suite (`vitest.config.ts:9`, `:14`, `:31-41`).

CI runs the same three steps against a throwaway PostgreSQL 18 service container, applies the migrations to it with `npx prisma migrate deploy`, and fails when any test outside the MinIO integration suite was skipped, or when no integration test ran (`.github/workflows/ci.yml:18-122`, the skip guard at `:78-121`). A second CI job compiles and tests the contracts and checks the committed ABIs (`:129-169`). The suites themselves are described in [testing.md](testing.md).

## 6. Database scripts

| Script | What it does | Writes | Safety |
| --- | --- | --- | --- |
| `db:generate` | `prisma generate` | the client under `src/generated/prisma` (`prisma/schema/schema.prisma:1-4`) | Not verified: that it needs no database; the Docker build stage runs it as part of `npm run build` with no database setting in that stage (`Dockerfile:12-17`) |
| `db:validate` | `prisma validate` | nothing | safe |
| `db:migrate:dev` | `prisma migrate dev` | a new migration in `prisma/migrations` and the changes in the database it names | local databases only (`AGENTS.md`) |
| `db:migrate:deploy` | `prisma migrate deploy` | applies the migrations in `prisma/migrations` that the database has not seen | `AGENTS.md`: only against a local database |

`prisma.config.ts` points Prisma at the schema directory `prisma/schema`, the migrations directory `prisma/migrations` and the connection `DIRECT_DATABASE_URL`, with the local default `postgresql://prisma:prisma@localhost:5432/vistablox` when it is unset (`prisma.config.ts:1-16`). `DIRECT_DATABASE_URL` is the migration connection; `DATABASE_URL` is the runtime one (`README.md`, "Local setup"). The `pgboss` schema is not created by any Prisma migration; pg-boss creates it itself when a process starts ([jobs-and-workers.md](jobs-and-workers.md) section 3.1).

The compose stacks apply migrations through a one-shot `migrate` service built from the `migrate` image; `api` and `worker` start only after it completed successfully (`docker-compose.yml:87-95`, `docker-compose.staging.yml:96-111`, `:248-252`, `:279-283`). The staging service takes its connection from `DIRECT_DATABASE_URL` pointing at the compose-local database container (`docker-compose.staging.yml:108`). The local sequence in the README is `createdb`, `cp .env.example .env`, `npm install`, `npm run db:generate`, `npm run db:migrate:dev`, `npm run dev`.

The README describes `docker compose down -v` as stopping and removing the containers and the Postgres volume (`README.md:171`); the data goes with it, so use it only on a stack whose data can go.

## 7. Contracts scripts

The Solidity package under `contracts/` has its own dependency tree and is part of neither `npm run build` nor `npm run check` (`contracts/package.json`, `scripts/export-contract-abis.mjs:4-14`). Install it once with `npm --prefix contracts ci`; Hardhat downloads the solc version the config pins on first use, so the first compile needs outbound network access (`.github/workflows/ci.yml:143-149`).

| Script | What it does | Writes |
| --- | --- | --- |
| `contracts:compile` | `hardhat compile` in `contracts/` (`contracts/package.json:6`) | `contracts/artifacts`, `contracts/cache` (both untracked, `.gitignore:9-10`) |
| `contracts:test` | `hardhat test` (`contracts/package.json:7`) over `contracts/test/*.test.js` | nothing tracked |
| `contracts:export-abi` | `node scripts/export-contract-abis.mjs` | the ABI, never the bytecode, of `VistaBloxProperty`, `VistaBloxIpoEscrow` and `VistaBloxWalletRegistry` into `src/infrastructure/blockchain/abis/<name>.abi.json` (`scripts/export-contract-abis.mjs:16-23`) |

Run `contracts:export-abi` after `contracts:compile` whenever a contract's public interface changes and commit the result; CI re-runs it and fails when the committed files differ (`.github/workflows/ci.yml:154-169`).

`contracts/scripts/deploy.js` is not an npm script. It deploys the three contracts, grants every operational role on the property and escrow contracts to the deploying account, and prints the addresses (`contracts/scripts/deploy.js:22-63`). It reads `VISTABLOX_BASE_URI` (default `https://vistablox.io/api/metadata/{id}.json`) and `EURC_TOKEN_ADDRESS`; on a network other than the simulated ones it refuses to run without `EURC_TOKEN_ADDRESS`, and on a simulated one it deploys a mock EURC (`:3-20`). The networks in `contracts/hardhat.config.js` are `hardhat`, `localhost`, `base-sepolia` and `base`, and the last two take `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL` and `DEPLOYER_PRIVATE_KEY` from the environment or from `.env` files (`contracts/hardhat.config.js:7-8`, `:19-37`). Nothing in the repository documents how the script is started, and nothing in it distinguishes `base` from `base-sepolia` beyond the address check. A deployment spends real gas on a real network and is a decision for the founder (AD-234 keeps settlement dormant in production).

## 8. Entry points that are not npm scripts

| Entry point | What it is |
| --- | --- |
| `node dist/infrastructure/storage/ensure-minio-bucket.js` | The command of the one-shot `storage-init` service in both compose files (`docker-compose.yml:67-71`, `docker-compose.staging.yml:71-75`). It reads the `MINIO_*` variables with its own schema, creates the five buckets when missing, enables versioning on four, object lock on the disclosure and audit buckets, and a 30-day expiry on the quarantine bucket (`src/infrastructure/storage/ensure-minio-bucket.ts:8-49`). It is idempotent and is described in [document-storage.md](document-storage.md). |
| `scripts/deploy/staging.sh` | Checks that `.env.staging` is readable and contains `POSTGRES_PASSWORD`, validates the staging compose file, then runs `docker compose up -d --build --remove-orphans` (`scripts/deploy/staging.sh:4-19`). It rebuilds and restarts every staging service. Merging to `main` does not run it; whoever deploys staging does (`AGENTS.md`). |
| `src/modules/auth/infrastructure/shared/better-auth.cli.ts` | Exports a Better Auth instance built straight from `process.env`, with a local database URL and a fixed development-only string as the secret as fallbacks (the string is in the file and is not repeated here), and non-secure cookies (`:1-16`). No script and no module imports it (searched the repository for `better-auth.cli`: no reference). It is compiled into `dist/` with everything else under `src`. |
| `tmp/create-dev-intake-fixture.ts` | A development fixture script that is neither an npm script nor compiled (`tsconfig.json:16` and `tsconfig.build.json:9` include `src` (and, for type checking, `tests` and two root files), not `tmp`). It imports the Prisma client factory from the absolute path `/app/dist/infrastructure/database/prisma.js` (`:1`) and reads `DATABASE_URL`, falling back to a local URL (`:3`). In one transaction it deletes the intake cases `case_dev_zagreb_full_fixture` and `case_dev_porto_ipo_fixture`, the legal practice `legal_dev_fixture` and the appraisal firm `appraisal_dev_fixture`, then creates two sample listings, a completed Zagreb case with three reservations and an open Porto IPO, whose rows refer to the fixed account `acct_01M2MPJWK6NSHR52J2BMPESR0R` (`:4-14`, `:24-115`), and prints the created ids as JSON (`:116-119`). It has no guard against a database that is not local. Nothing in the repository documents how it is started; the `/app` path is the working directory of the images (`Dockerfile:32`, `:43`), but running a `.ts` file there is not verified (the images hold no TypeScript runner, `Dockerfile:34`, `:45`). A test reads its text (`tests/investor-activity-repository.test.ts:68`). |

## 9. Running a command in the staging containers

The staging stack is `docker-compose.staging.yml` with the environment file `.env.staging`. Its services include `vistablox-api` and `worker` (`docker-compose.staging.yml:113`, `:271`), whose images hold the compiled commands and `package.json` (section 1). The form that the runbook uses is:

```bash
docker compose --env-file .env.staging -f docker-compose.staging.yml exec <service> \
  npm run <script> -- <arguments>
```

| Command | Service |
| --- | --- |
| `staff:bootstrap-first-admin` | `vistablox-api` |
| `intake:backfill-events` | `vistablox-api` or `worker` |
| `jobs:replay-dead-letter` | `worker` (`docs/dead-letter-jobs.md`, "Replay") |
| `settlement:open-ipo-escrow-campaigns` | `worker`, which carries the `CHAIN_*` settings |

The command runs with the container's own environment: `NODE_ENV=production` from the image and `APP_ENV=staging` from the compose anchor (`Dockerfile:33`, `Dockerfile:44`, `docker-compose.staging.yml:154`). Not verified: the output of an `exec`ed command is expected to go to the terminal that ran `exec`, and not to `docker compose logs`, which show the process the container started (Docker was not run for this chapter). The scripts that need the Prisma CLI, TypeScript or Hardhat (`build`, `typecheck`, `test`, `architecture`, `db:*`, `contracts:*`) are not in these images and are not run this way. Whether `npm` itself is in the image is a property of the `node:22-alpine` base (`Dockerfile:31`, `:42`); the runbook's replay command relies on it.

## 10. Known limitations

| # | Limitation | Where | Issue |
| --- | --- | --- | --- |
| 1 | `intake:backfill-events` ignores every argument, `--help` included, and has no dry run; its count of imported events includes rows that already had their event and rows whose case is gone; it reads every matching audit row in one query. | `src/cli/backfill-intake-case-events.ts:52-56`, `:73-99` | none |
| 2 | No database script checks that its target is local. The only protection is the value of `DIRECT_DATABASE_URL` in the shell, and the fallback of `prisma.config.ts` is a local URL. | `prisma.config.ts:4-6`, `package.json:26-27` | none |
| 3 | `jobs:replay-dead-letter` leaves no audit row; its log line goes to the command's standard error. | `src/cli/replay-dead-letter-job.ts:47`, `:83-95` | #209 |
| 4 | An invalid or incomplete environment makes every command end with a stack trace and exit code 1, not with its usage exit codes, because `loadEnvironment()` runs outside the `try`. | `src/cli/bootstrap-first-admin.ts:63`, `src/cli/replay-dead-letter-job.ts:46`, `src/cli/open-ipo-escrow-campaigns.ts:59` | none |
| 5 | The testnet refusal exists only in `settlement:open-ipo-escrow-campaigns`; the worker's `settlement.open_ipo_escrow_campaign` job and the finalizer are not limited to a testnet. | `src/modules/settlement/domain/ipo-escrow-campaign.policy.ts:168-204`, `src/worker.ts:710-733` | `C-008` in the conflict register |
| 6 | `better-auth.cli.ts` is an unused file with a development secret as its fallback, and it ships in `dist/`. | `src/modules/auth/infrastructure/shared/better-auth.cli.ts:1-16`, `tsconfig.build.json:9` | none |
| 7 | `tmp/create-dev-intake-fixture.ts` deletes and recreates sample intake cases in whatever database `DATABASE_URL` names, with no check that the database is local and no documented way to start it. | `tmp/create-dev-intake-fixture.ts:3`, `:24-30` | none |

> Pending #233: the replay command's `--operator` argument and audit row close row 3.

## 11. Related documents

| Topic | Document |
| --- | --- |
| The worker, its queues and the dead-letter mechanism | [jobs-and-workers.md](jobs-and-workers.md) |
| Triage and replay of a dead-lettered job | [dead-letter-jobs.md](dead-letter-jobs.md) |
| Staff accounts, invitations and the first admin | [staff-access.md](staff-access.md) |
| The environment schema | [configuration.md](configuration.md) |
| Running and deploying the stack | [operations.md](operations.md) |
| The test suites | [testing.md](testing.md) |
| IPO escrow campaigns and the offering flow | [investor-offering.md](investor-offering.md) |
| Escrow mint reconciliation | [escrow-mint-reconciliation.md](escrow-mint-reconciliation.md) |
| Object storage and the bucket initialiser | [document-storage.md](document-storage.md) |
| Intake case events | [modules/intake.md](modules/intake.md) |
| Data model | [data-model.md](data-model.md) |

## 12. Not verified

- **No command was run.** The arguments, outputs, refusals and exit codes are read from the source files named in each section, including the usage strings. No command was started against a database, a chain or a container.
- **PostgreSQL 18.** The migrations, the advisory locks and the queries of the commands were read, not run, on any PostgreSQL version.
- **Docker.** How `docker compose exec` behaves in the staging stack, which services run, whether `npm` is present in the images, and where the output of an exec'd process goes were not checked. They follow from `Dockerfile` and `docker-compose.staging.yml` and from the runbook.
- **`.env.staging` and production.** The file is not in the repository, so which `CHAIN_*`, SMTP and cache settings the staging containers have is unknown. No production configuration was read.
- **Prisma and Hardhat.** What `prisma migrate dev` and `prisma migrate deploy` do beyond their names, that `prisma generate` needs no database (inferred from the Docker build stage, not run), and how `contracts/scripts/deploy.js` is started (the Hardhat `run` task is the usual way; nothing in the repository says so).
- **Real providers.** A real RPC provider, real Coinbase and a real SMTP server were not exercised. The `Pending` lines restate open pull requests: their diffs against main were read at the pull request heads #225 (e858bb0) and #233 (1c865a4); neither was merged, built or run, and a head can move. A trial merge (`git merge-tree --write-tree`, nothing checked out) of #233 into 48aa967 conflicts in `src/shared/jobs/dead-letter-replay.ts` and `tests/dead-letter-replay.integration.test.ts`; the one of #225 does not conflict.
