# Testing and continuous integration

Valid for main at 48aa967 (2026-11-18).

How the repository is tested and how the checks run on every pull request: the `npm run check` gate, the Vitest suite and its isolation rules, the integration suites that need PostgreSQL, the Hardhat contract tests, the three GitHub workflows, and the places where a green run proves less than a reader might assume. The readers are the engineer who writes or runs a test, the reviewer who reads a CI result, and the operator who needs to know what the checks do not cover.

Citations are `(path:line)` at 48aa967; the identifier is named next to the number because line numbers drift. A path that starts with `node_modules/` is library code read from an installed copy at the version `package-lock.json` locks (checked: `vitest` 4.1.11); it is outside the repository and was read from a separate install, not from this checkout. A line that starts with `> Pending #N:` says what an open pull request changes in the statement above it; nothing under such a line is built on main. A statement marked `Not verified` could not be checked; the list is in [Not verified](#10-not-verified). Every count of files is made by a script that lists `git ls-files tests` at 48aa967 and classifies each path by its suffix or by a pattern in its text; the method is stated where the number is given. No test was run for this chapter: the suite needs a database, and this review ran no database command. The behaviour of the Vitest configuration was checked on a copy of `vitest.config.ts` (section 3) and the behaviour of the CI skip guard by running its script against a synthetic report (section 5.3).

Contents: [1 Quick reference](#1-quick-reference) · [2 The test suite](#2-the-test-suite) · [3 Vitest configuration](#3-vitest-configuration) · [4 Running the tests locally](#4-running-the-tests-locally) · [5 CI](#5-ci) · [6 How doubles are injected](#6-how-doubles-are-injected) · [7 Conventions for writing a test](#7-conventions-for-writing-a-test) · [8 Known limitations](#8-known-limitations) · [9 Related documents](#9-related-documents) · [10 Not verified](#10-not-verified)

## 1. Quick reference

| Goal | Command | Where it is defined, and what to know |
| --- | --- | --- |
| The full local gate | `npm run check` | Runs `npm run typecheck && npm run architecture && npm test` (`package.json:23`, script `check`). `AGENTS.md:9` asks that it passes before a change is called done. |
| Type check | `npm run typecheck` | `tsc --noEmit` (`package.json:19`). `tsconfig.json:16` includes `src/**/*.ts`, `tests/**/*.ts`, `prisma.config.ts` and `vitest.config.ts`, so the tests are type-checked too. It needs the generated Prisma client, which git ignores (`.gitignore:7`, `src/generated/prisma/`); `package.json` has no `postinstall` or `prepare` script, so run `npm run db:generate` (`package.json:24`) after a fresh `npm ci`. |
| Architecture rules | `npm run architecture` | `depcruise src --config dependency-cruiser.config.cjs` (`package.json:22`). Four rules, all `error`: `routes-must-not-import-repositories`, `domain-must-stay-pure`, `no-cross-domain-internals`, `no-circular` (`dependency-cruiser.config.cjs:5`, `:11`, `:17`, `:23`). It scans `src` only, never `tests`. |
| All tests | `npm test` | `vitest run` (`package.json:20`). Unit tests always run; each integration file skips itself without its environment variable (section 4). |
| Watch mode | `npm run test:watch` | `vitest` (`package.json:21`). |
| One file | `npx vitest run tests/<name>.test.ts` | The Vitest command line, not a repository script. |
| One test by title | `npx vitest run -t "<title>"` | The Vitest command line. Titles are not unique in two files (section 8, item 8). |
| With the integration suites | `TEST_DATABASE_URL=<url> npm test` | `README.md:152`. The variable must be in the shell; a `.env` file does not supply it (section 3.4). |
| Contract compile, test, ABI export | `npm run contracts:compile`, `npm run contracts:test`, `npm run contracts:export-abi` | `package.json:28-30`. The first two run inside `contracts/` and need `npm --prefix contracts ci` first (`.github/workflows/ci.yml:144`). |
| Check that a change reports skipped tests | read the Vitest summary | `AGENTS.md:10` asks that a report says when integration tests were skipped. |

There is no lint script, no formatter script, no coverage script and no build step in the CI workflow; section 5.6 lists what the workflow does not run.

## 2. The test suite

### 2.1 Layout and counts

All test code is TypeScript under `tests/`, in one flat directory plus `tests/support/`. `git ls-files tests` lists 296 files, all with the extension `.ts`: 283 directly in `tests/` and 13 in `tests/support/`. Every one of the 283 ends in `.test.ts`. The Hardhat contract tests are separate: four `.test.js` files in `contracts/test/`, and no other `.test.` or `.spec.` file is tracked outside `tests/` and `contracts/test/` (`git ls-files` searched for both patterns).

| Kind | Rule used by the script | Files |
| --- | --- | --- |
| Unit and component tests | a `.test.ts` file whose name does not end in `.integration.test.ts` | 228 |
| Integration tests | a file whose name ends in `.integration.test.ts` | 55 |
| Test files in total | | 283 |
| Support helpers | files in `tests/support/` | 13 |

Of the 55 integration files, 54 gate on `TEST_DATABASE_URL` and one, `tests/minio-disclosure-document-store.integration.test.ts`, gates on `TEST_MINIO_ENDPOINT`, `TEST_MINIO_ACCESS_KEY` and `TEST_MINIO_SECRET_KEY` (section 3.4; counted by searching each file's text for the literal `TEST_DATABASE_URL`). The suffix is a naming convention, not a mechanism: the CI skip guard (section 5.3) and the isolation tests (section 3.2) identify integration files by it. One file departs from the convention: `tests/device-auth-dpop-replay-integration.test.ts` carries the word in its name with a hyphen, needs no database, and is counted above as a unit file; the guard's counter of executed integration tests does not count it (`.github/workflows/ci.yml:101`, `name.endsWith(".integration.test.ts")`).

> Pending #225: adds `tests/clamav-scanner.test.ts`, a unit suite that runs `ClamAvScanner` against a fake `clamd` on a socket.

> Pending #229: adds a `tests/clamav-scanner.test.ts` of its own and `tests/clamav-scanner.integration.test.ts`, which skips unless `CLAMAV_TEST_HOST` is set (section 5.3).

### 2.2 What kinds of test exist

The suite has no per-module directories; the area is the start of the file name (`wallet-`, `offering-`, `intake-`, `device-`, `staff-`, `kyc-`, `didit-`, `coinbase-`). The tests fall into the groups below. A file can belong to several, so the counts are not a partition.

| Group | How it is written | Typical example |
| --- | --- | --- |
| Pure policy and domain tests | call an exported function with literal input and compare the result | `tests/intake-entry-policy.test.ts` calls `evaluateIntakeEntry` (`tests/intake-entry-policy.test.ts:19-36`) |
| Service tests with fake ports | a service is built with `vi.fn()` objects that implement its repository, client or sender interface | `fakeKycRepository` in `tests/app.test.ts` (143 files use `vi.fn(`, counted by searching each test file's text) |
| HTTP tests | `supertest` drives an Express app in memory | 58 files import `supertest` (section 6.2) |
| Environment tests | call `loadEnvironment(source)` with an explicit object, never `process.env` | `tests/trust-proxy-environment.test.ts`, `tests/dead-letter-operations.test.ts` (`src/config/environment.ts:650`, parameter `source`) |
| Source-text tests | read a source, migration, configuration or documentation file as text and assert on it | 14 files read repository files (section 2.5) |
| Protocol tests with real cryptography | build real certificates, JWTs or WebAuthn responses in the test | `tests/support/software-authenticator.ts` (`createSoftwareAuthenticator`) signs genuine ES256 assertions |
| Database integration tests | a real Prisma client and often a `pg` pool against the test database | 54 files (section 4) |
| Chain tests | a stub JSON-RPC node on `node:http`, or fake chain objects | `tests/support/transfer-chain-world.ts` (section 6.3) |

### 2.3 Tests by module

The next table counts, for each of the eleven modules under `src/modules`, the test files whose text contains the path fragment `src/modules/<module>/`. A file that imports two modules is counted twice, and a test that reaches a module only through a `tests/support` helper or through `createApp` is not counted, so the numbers say where the module's code is imported, not how well it is covered.

| Module | Test files importing it | Of which integration |
| --- | --- | --- |
| `account` | 29 | 7 |
| `auth` | 102 | 18 |
| `health` | 0 | 0 |
| `identity` | 34 | 16 |
| `intake` | 39 | 6 |
| `investor-activity` | 5 | 2 |
| `offering` | 51 | 13 |
| `profile` | 4 | 2 |
| `rental` | 1 | 0 |
| `settlement` | 31 | 10 |
| `wallet` | 23 | 8 |

54 test files import no module path at all; they test code under `src/shared`, `src/infrastructure` or `src/config`, read a start-up script, a migration or a document as text, or test the Vitest configuration itself. `health` has no direct importer because its two routes are exercised through `createApp` (`tests/app.test.ts:270` `/health/live`, `:302` `/health/ready`) and the worker's probe through `tests/worker-heartbeat.test.ts:18` (`/health/live`, port `healthPort`).

### 2.4 Support helpers

`tests/support/` holds shared fakes and fixtures. The column "Test files" counts the `.test.ts` files that import the helper by name (counted by searching for `support/<name>`); one helper is imported by another, noted in the last column.

| File | Lines | Purpose | Test files | Integration among them |
| --- | --- | --- | --- | --- |
| `escrow-mint-fakes.ts` | 669 | `FakeEscrowChain` (a scripted chain for the escrow finalizer, with campaign states `CAMPAIGN_STATE_OPEN`, `CAMPAIGN_STATE_SUCCESSFUL`, `CAMPAIGN_STATE_FAILED`), `InMemorySettlementRepository`, `makeCapturingLogger`, `successfulCampaign` (`tests/support/escrow-mint-fakes.ts:88`, `:328`, `:358`, `:642`) | 4 | 1 |
| `operator-key-lock-fakes.ts` | 50 | `InProcessOperatorKeyLock`, an in-process stand-in for the Postgres operator-key lock that records `lock:enter` and `lock:exit` in a timeline (`tests/support/operator-key-lock-fakes.ts:9`) | 5 | 2 |
| `settlement-escrow-contracts.ts` | 8 | two constants, `CONFIGURED_ESCROW_CONTRACT` and `REDEPLOYED_ESCROW_CONTRACT`, for the reservation-gate tests | 6 | 2 |
| `settlement-escrow-db.ts` | 40 | `markSettlementEscrowReady` and `deleteSettlementEscrowReadiness`, which write and remove an escrow-campaign observation row (`tests/support/settlement-escrow-db.ts:15`, `:38`); imports `settlement-escrow-contracts.ts` | 2 | 2 |
| `software-authenticator.ts` | 114 | `createSoftwareAuthenticator(rpId)`: a real ES256 platform authenticator in software, so the relying party's origin, `rpId`, challenge and signature checks all run (`tests/support/software-authenticator.ts:19`) | 3 | 0 |
| `transfer-chain-world.ts` | 244 | `createTransferWorld` and `serveTransferWorld`: an HTTP server that answers JSON-RPC from a block-keyed state, so an `eth_call` that is not pinned to a block reads a different state (`tests/support/transfer-chain-world.ts:106`, `:217`) | 3 | 0 |
| `wallet-fresh-auth-app.ts` | 107 | `buildWalletFreshAuthApp`: `createApp` with the real authentication middleware, fresh-authentication probe and wallet router, and fakes only at the edges (`tests/support/wallet-fresh-auth-app.ts:24`, `:95`) | 3 | 2 |
| `wallet-registration-db.ts` | 183 | `deferred`, `withWriteHooks` (a Prisma query extension that pauses or fails one write) and `WalletRegistrationFixtures` (accounts with unique ids, removed again) (`tests/support/wallet-registration-db.ts:10`, `:32`, `:56`) | 3 | 3 |
| `wallet-registration-fakes.ts` | 446 | `makeFakeChain`, `FakeWalletRegistrationRepository`, `FakeEvidenceReader`, `confirmedRow` (`tests/support/wallet-registration-fakes.ts:54`, `:131`, `:399`, `:418`) | 5 | 1 |
| `wallet-registry-logs.ts` | 85 | builders for `WalletRegistered` logs and receipts as a node returns them (`registeredTopics`, `rawLog`, `receipt`) | 3 | 0 |
| `wallet-registry-summary.ts` | 26 | `QUIET_CLAIM_AND_EVIDENCE_COUNTERS`, zero counters for the watcher summary | 3 | 1 |
| `wallet-transfer-fakes.ts` | 51 | `buildPassingSnapshot` and `buildTransferChainReader` for the transfer preflight | 5 | 1 |
| `without-comments.ts` | 38 | `withoutComments(source)`: the source with every comment blanked by the TypeScript parser, offsets unchanged, for tests that read a start-up script as text (`tests/support/without-comments.ts:13`) | 5 | 0 |

The line counts are `wc -l` of each file. A helper that builds a URL with a provider key names it as a constant, `RPC_URL_WITH_KEY` in `tests/support/transfer-chain-world.ts:27`; the value is a made-up string used to prove that error messages do not carry the URL, and it is not repeated here.

### 2.5 Tests that read repository files as text

Fourteen test files read a file of the repository with `readFileSync` or `readdirSync` (found by searching `tests/` for both). They exist because some start-up code cannot be imported into a test and because some invariants span files.

| File and line of the read | What it reads | What it asserts |
| --- | --- | --- |
| `tests/coinbase-onramp-webhook-wiring.test.ts:23` (`load`) | `src/worker.ts` and `src/server.ts`, comments blanked | the Coinbase webhook consumer is registered and the route is mounted |
| `tests/onramp-late-evidence-wiring.test.ts:18` (`load`) | `src/worker.ts`, `src/server.ts` and `src/app.ts`, comments blanked | the late-evidence handler, its job and the staff route are wired |
| `tests/wallet-registry-worker-wiring.test.ts:16` | `src/worker.ts`, comments blanked | the wallet-registry health queue and the watcher are created and scheduled (`tests/wallet-registry-worker-wiring.test.ts:32-46`) |
| `tests/job-queues.test.ts:78` (`sourceOf`) | `src/worker.ts` and `src/server.ts` | both processes create queues only through `ensureJobQueue`, the dead-letter queue is created first, every queue the worker consumes is also created, and the queues the api creates have the kind the worker gives them (`tests/job-queues.test.ts:95-185`, `queueKinds` at `:81`) |
| `tests/dead-letter-operations.test.ts:25-26` (`ensuredQueues`) | `src/worker.ts` and `src/server.ts` | every queue the two processes create has an entry of the same kind in `JOB_QUEUE_OWNERSHIP`, and the map names no queue that neither creates (`tests/dead-letter-operations.test.ts:34-42`) |
| `tests/wallet-registry-alert-config.test.ts:16-17` (`sourceOf`) | `src/config/environment.ts`, `.env.example`, the `&app-environment` block of `docker-compose.staging.yml` (`:48-50`), `docs/wallet-registration-operations.md` (`:72`), `README.md` and `docs/investor-profile.md` (`tests/wallet-registry-alert-config.test.ts:221-222`) | each of five alert variables is declared, listed in `.env.example` with its default and passed by the staging anchor (`tests/wallet-registry-alert-config.test.ts:52-56`); the runbook documents the code's events with their severities (`:94-96`), contains no `0x` value of twelve or more hex digits (`:202-204`), gives every `docker compose` command the form `docker compose --env-file .env.staging -f docker-compose.staging.yml ` (`:211-218`), and is linked from `README.md` and `docs/investor-profile.md` (`tests/wallet-registry-alert-config.test.ts:220-223`) |
| `tests/platform-settings-seed.test.ts:49`, `:58`, `:71-75` | every file under `src/` and every migration's `migration.sql` | each `platform.settings` read with a literal key has a seed row in a migration |
| `tests/auth-session-authentication-level-guard.test.ts:26`, `:32` | the migrations | the latest `CHECK` on `authenticationLevel` allows exactly the values of `AUTHENTICATION_LEVELS` |
| `tests/investor-activity-repository.test.ts:67-69` (`fixtureCapitalStates`) | `tmp/create-dev-intake-fixture.ts` | the development fixture writes only capital states the repository reads (`tests/investor-activity-repository.test.ts:107`) |
| `tests/investor-profile-doc-structure.test.ts:13` | `docs/investor-profile.md` | the heading outline of that guide |
| `tests/wallet-registry-heartbeat-isolation.test.ts:23`, `:26`, `:47` | every `*.integration.test.ts` file, comments blanked | the watcher heartbeat and cursor rows have one owner among the integration tests (section 8, item 3) |
| `tests/wallet-address-migration.integration.test.ts:43`, `tests/wallet-claims-migration.integration.test.ts:16`, `tests/wallet-registration-evidence-migration.integration.test.ts:34` | one migration's `migration.sql` each | the migration's SQL is replayed on scratch tables or a scratch schema and its data handling is checked on the real file (these three need `TEST_DATABASE_URL`) |

`withoutComments` exists because a plain text search is satisfied by a call that has been commented out (`tests/support/without-comments.ts`, header comment). Because these tests read the paths they name, moving the code they read breaks them.

> Pending #237: `tests/onramp-late-evidence-wiring.test.ts` reads `src/composition/compose-offering.ts` instead of `src/app.ts`, because `createApp` is split into per-module compose functions and `src/app.ts` shrinks.

> Pending #236: adds `tests/staging-compose-clamav.test.ts`, which reads the `&app-environment` block of `docker-compose.staging.yml` as text.

Three Markdown files are therefore pinned by tests: `docs/investor-profile.md` (its heading outline and a link), `docs/wallet-registration-operations.md` (its event table, field lists, hex rule and command form) and `README.md` (one link). An edit to those three files can fail the test job. No other file under `docs/` is read by a test, and no test or workflow checks links in `docs/` (searched `tests/` for string literals ending in `.md`: five matches, in `tests/investor-profile-doc-structure.test.ts:13`, `tests/wallet-registry-alert-config.test.ts:72`, `:221`, `:222` and `tests/open-ipo-escrow-campaigns-command.test.ts:331`, the last of which asserts on a command's output text and reads no file).

## 3. Vitest configuration

The whole configuration is one file, `vitest.config.ts` (43 lines). There is no second Vitest config, no `vitest.workspace` file, no setup file and no global setup (`tests/` and the repository root searched for `setupFiles`, `globalSetup` and `vitest.workspace`: no match; the resolved values below are empty).

### 3.1 Settings

The resolved values were read by running `createVitest` on a copy of `vitest.config.ts` with empty stand-in test files, the same call the isolation test makes (`tests/staff-bootstrap-isolation.test.ts:20`). Library lines are from `node_modules/vitest` 4.1.11.

| Setting | Value | Source |
| --- | --- | --- |
| Environment | `node` | `vitest.config.ts:18` |
| Files that count as tests | `**/*.{test,spec}.?(c\|m)[jt]s?(x)`, Vitest's default | `node_modules/vitest/dist/chunks/defaults.9aQKnqFk.js:5` (`defaultInclude`) |
| Excluded | `**/node_modules/**`, `contracts/**`, and a third pattern for a hidden directory that holds full copies of the repository made by local tooling, so those copies' tests do not run a second time | `vitest.config.ts:19-24` (`exclude` at `:24`) |
| Setup files, global setup | none (resolved to empty lists) | `vitest.config.ts` has no such key |
| Globals | off; each test file imports its test functions from `vitest` (283 of 283 files do), although `tsconfig.json:14` also lists `vitest/globals` among the types | `node_modules/vitest/dist/chunks/defaults.9aQKnqFk.js:49` (`globals: false`) |
| Worker processes | child processes (`pool: "forks"`), one fresh module graph per test file (`isolate: true`) | `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:180`, `defaults.9aQKnqFk.js:47` |
| Test files in parallel | yes (the option is unset) | `node_modules/vitest/dist/chunks/cac.uFydS1Z4.js:926` (the command-line help for `fileParallelism` gives the default as `true`) |
| Tests inside a file | run one after another in definition order; the config sets no `shuffle` and no `concurrent` | `coverage.DM_a_rWm.js:477` (`BaseSequencer` unless `shuffle`) |
| Test timeout | 5,000 ms | `coverage.DM_a_rWm.js:538` (`testTimeout`) |
| Hook timeout | 10,000 ms | `coverage.DM_a_rWm.js:539` (`hookTimeout`) |
| Retry | none: the option is unset and resolves to `undefined` | `vitest.config.ts` has no `retry` key |
| `.only` | allowed locally; the run fails when the environment variable `CI` is set | `defaults.9aQKnqFk.js:46` (`allowOnly: !isCI`); checked on a probe project with `CI=true` (exit 1, "Unexpected .only modifier") and without it (exit 0). No test file contains `.only`, `.skip` or `.todo` (searched all 283). |
| Coverage | provider `v8`, reporters `text` and `html` | `vitest.config.ts:25-28`; `package-lock.json` has no `node_modules/@vitest/coverage-v8` package entry (the name occurs twice, as an optional peer dependency of `vitest`, `package-lock.json:7853`, `:7881`), `package.json` does not list it and no script passes `--coverage`, so coverage is not measured |

Tests that need more than 5 s say so with a third argument. The literal `30_000` appears in 23 test files (counted by searching each file's text); `tests/job-dead-letter.integration.test.ts:203`, `:226` and `:247` use `60_000`.

### 3.2 Projects and the order of runs

`projects` (`vitest.config.ts:31-41`) splits the files into three projects, each `extends: true` so it inherits everything above. A project's `exclude` is added to the root list, not substituted for it (`vitest.config.ts:29-30`, and asserted by `tests/staff-bootstrap-isolation.test.ts:37-41`).

| Project | Files | `sequence.groupOrder` | Why |
| --- | --- | --- | --- |
| `parallel` | every test file except the two below: 281 (283 minus 2) | 0 (Vitest's default, `coverage.DM_a_rWm.js:478`) | all share the one test database and run at once |
| `wallet-expiry-alone` | `tests/wallet-claim-expiry.integration.test.ts` | 1 | the pending-claim expiry sweep is global; its fixtures are older than any other suite's pending claims, and the wallet registry health suite asserts which pending claim is the oldest (`vitest.config.ts:10-14`) |
| `bootstrap-alone` | `tests/staff-bootstrap-repository.integration.test.ts` | 2 | its "issued" cases pass only while no account in the database holds an active `admin_operations` role, and the account-recovery, staff-lifecycle and staff-WebAuthn suites create such accounts while they run (`vitest.config.ts:3-9`) |

Vitest sorts the specifications by `sequence.groupOrder` first (`node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:50-53`, the `sort` method), so the second and third projects start only after every file of the earlier groups has finished. `tests/staff-bootstrap-isolation.test.ts` fails if the bootstrap file shares its project with another file or its group is not later than every other file's (`tests/staff-bootstrap-isolation.test.ts:44-48`), if the expiry file shares its project or its group is not later than every parallel file's (`:53-60`), or if a file from `contracts/`, the hidden directory or `node_modules/` is picked up (`:40-41`). The test is a unit test: it calls `createVitest` on the real config and needs no database. The README states the same rule (`README.md:155`, `:157`).

The two serialised suites protect two shared-state hazards. A third class of hazard, one `platform.settings` row read and deleted by one integration file while another writes it, is handled by ownership instead of ordering: `tests/wallet-registry-heartbeat-isolation.test.ts` fails if any integration file other than `wallet-registry-health.integration.test.ts` touches the watcher heartbeat row (`tests/wallet-registry-heartbeat-isolation.test.ts:25-34`) or names its cursor key (`:43-52`; section 8, item 3).

### 3.3 Running one project or file

A file in one of the alone projects is run by its path like any other (`npx vitest run tests/staff-bootstrap-repository.integration.test.ts`). Running the whole suite is what exercises the order between the three projects.

### 3.4 How an integration suite finds its database

Fifty-four integration files contain the same two statements, for example `tests/removed-customer-factors.integration.test.ts:5` and `:10`:

```ts
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("…", () => { /* … */ });
```

(`tests/offering-presentation.integration.test.ts:12` and `:14` are the same with another title.) The file builds its own client from the value, `createPrismaClient(databaseUrl ?? "")` (`src/infrastructure/database/prisma.ts:5`), and never calls `loadEnvironment`. Three consequences follow.

1. **Only an unset variable skips the suite.** A variable that is set to the empty string is not `undefined`, so the suite runs and fails on its first connection. (Reasoned from the expression; not run.)
2. **A `.env` file does not enable the suite.** Vitest does not copy `.env` into `process.env`. A probe project containing a `.env` with an ordinary variable and one with the `VITE_` prefix showed the first as `undefined` in a test and the second visible through `import.meta.env`. `.env.example:292` lists `TEST_DATABASE_URL`, but the variable has to be in the shell that runs `npm test`. Prisma's own commands do read `.env`, because `prisma.config.ts:1` imports `dotenv/config`; that is why `DIRECT_DATABASE_URL` can live in `.env` while `TEST_DATABASE_URL` cannot.
3. **The constructor of pg-boss runs at collection time unless it is deferred.** `PgBoss` validates its connection string in its constructor, and a `describe` body runs even when `skipIf` skips the suite, so a suite builds `PgBoss` inside `beforeAll` (`tests/offering-presentation.integration.test.ts:27-28`, the comment, and `:33`, the call inside `beforeAll`).

The MinIO suite uses `describe.skipIf(!configured)` with `configured` true only when `TEST_MINIO_ENDPOINT`, `TEST_MINIO_ACCESS_KEY` and `TEST_MINIO_SECRET_KEY` are all defined (`tests/minio-disclosure-document-store.integration.test.ts:14-20`); `TEST_MINIO_PORT` defaults to 9000 (`:18`).

## 4. Running the tests locally

### 4.1 Without a database

`npm test` needs nothing else. Unit tests run; the 54 database suites and the MinIO suite report their tests as skipped. There is no separate command for "unit tests only" (`README.md:145`). Run `npm run db:generate` once first, because tests import the generated Prisma client (`src/generated/prisma`, ignored by git).

### 4.2 With a local PostgreSQL 18

`README.md:147-157` and `.env.example:287-292` give the recipe; this is the same sequence with the repository's own compose service. The commands below were not run for this chapter (no database command was allowed); they follow those files.

1. Start PostgreSQL 18. The `postgres` service of `docker-compose.yml` is `postgres:18-alpine` with user, password and database all `vistablox` on port 5432 (`docker-compose.yml:2-9`): `docker compose up -d postgres`. A local installation works too; the README uses a role named `prisma` (`README.md:150`).
2. Create a separate, empty database for the tests, for example `docker compose exec postgres createdb -U vistablox vistablox_test` (README form: `createdb -U prisma vistablox_test`, `README.md:150`). Do not reuse the development database: the tests create and delete real rows (`README.md:147`), and the bootstrap suite needs a database in which no account holds an active `admin_operations` role (`vitest.config.ts:3-9`).
3. Apply the migrations to it: `DIRECT_DATABASE_URL=postgresql://vistablox:vistablox@localhost:5432/vistablox_test npm run db:migrate:deploy` (`README.md:151`; `prisma.config.ts:4-6` reads `DIRECT_DATABASE_URL`). `AGENTS.md:11` allows `db:migrate:deploy` against a local database only.
4. Run the suite: `TEST_DATABASE_URL=postgresql://vistablox:vistablox@localhost:5432/vistablox_test npm test` (`README.md:152`).

The test database is never Neon: `AGENTS.md:11` states that Neon is production-only and `README.md:157` records the decision to use a local PostgreSQL 18 for development and testing (AD-257). The tests need no seed script and no separate Vitest config; each integration file creates and removes its own fixture rows (`README.md:157`). Defaults that tests read from the database, such as the `platform.settings` values, come from the migrations.

### 4.3 What an integration run leaves behind

- **Fixture rows.** A file inserts its rows in `beforeAll` with ids that end in a fresh `randomUUID()` and deletes them in `afterAll`, child tables first (`tests/offering-presentation.integration.test.ts:15`, `:67-76`). A run that is killed before `afterAll` leaves its rows behind; the unique suffix keeps a later run from colliding with them.
- **Queued jobs.** Eighteen integration files construct a pg-boss instance (searched for `new PgBoss(`); three give it a private schema named `pgboss_replay_<suffix>`, `pgboss_dlq_<suffix>` or `pgboss_dormant_<suffix>` and drop it at the end (`tests/dead-letter-replay.integration.test.ts:26`, `:57`; `tests/job-dead-letter.integration.test.ts:32`, `:86`; `tests/offering-open-chain-dormant.integration.test.ts:26`, `:104`). The other fifteen use the default `pgboss` schema, and jobs that their code enqueues stay there: no test deletes them (searched `tests/` for `deleteQueue` and for `DELETE`, `TRUNCATE` or `DROP` on a line with `pgboss`: the only `deleteQueue` is `tests/offering-open-chain-dormant.integration.test.ts:218`, which removes one queue to recreate a missing-queue state). A worker started against a reused test database would consume those leftovers (section 8, item 4).
- **Time.** One test waits on purpose: in `tests/device-enrolment-insert-deadline.integration.test.ts`, `setTimeout(resolve, 6_000)` at `:190` holds a transaction past the database's idle-in-transaction limit, and its assertions bound the elapsed time (`:165`, `:209-210`).

### 4.4 The MinIO suite

`tests/minio-disclosure-document-store.integration.test.ts` runs against any S3-compatible server at `http://<TEST_MINIO_ENDPOINT>:<TEST_MINIO_PORT>`, creates a bucket named `vistablox-test-<uuid>` and removes it afterwards (`tests/minio-disclosure-document-store.integration.test.ts:21`, `:46`, `:59-62`). The `minio` service of `docker-compose.yml` publishes no port (`docker-compose.yml:38-51`), so from the host it needs a port mapping of your own; its credentials are the local ones in `docker-compose.yml:43-44`. CI does not run this suite (section 5.3).

### 4.5 The contract tests

`contracts/` is a separate Hardhat 3 package with its own `package.json` and lockfile (`contracts/package.json`). Install, compile, test:

```sh
npm --prefix contracts ci
npm run contracts:compile
npm run contracts:test
```

`hardhat test` runs the four Mocha files in `contracts/test/` (`VistaBloxIpoEscrow.test.js`, `VistaBloxProperty.test.js`, `VistaBloxWalletRegistry.test.js`, `VistaBloxWalletRegistry.smartAccount.test.js`; 59 `it(` calls, counted with `grep -c '^\s*it('` on each file) on Hardhat's in-process simulated network, `hardhat: { type: "edr-simulated" }` (`contracts/hardhat.config.js:20-22`). The first compile downloads the Solidity compiler pinned in `contracts/hardhat.config.js:12-18` (version 0.8.24), so it needs outbound network access (`.github/workflows/ci.yml:146-147`). The root Vitest run never picks these files up: `contracts/**` is excluded (`vitest.config.ts:24`). `npm run contracts:export-abi` rewrites the three ABI files that the api compiles against (`scripts/export-contract-abis.mjs:15-24`); it is not part of `npm run build` (`scripts/export-contract-abis.mjs:10-13`).

### 4.6 Reproducing the CI test job

The job is the sequence in section 5.2 against a throwaway database named `vistablox_test` with the placeholder credentials the workflow lists (`.github/workflows/ci.yml:46-51`). Locally: `npm ci`, `npx prisma generate`, `npx prisma migrate deploy` with `DIRECT_DATABASE_URL` set to the test database, `npm run typecheck`, `npm run architecture`, then `npm test -- --reporter=default --reporter=json --outputFile.json=vitest-report.json`. The skip guard exists only as a script inside the workflow file (`.github/workflows/ci.yml:85-122`); `scripts/` holds no copy of it, so to run it locally copy the block, strip its YAML indentation and set `VITEST_JSON_REPORT` to the report path.

## 5. CI

### 5.1 The three workflows

`.github/workflows/` holds three files and no deployment workflow; merging to `main` does not deploy staging (`AGENTS.md:27`).

| File | Trigger | What it does |
| --- | --- | --- |
| `.github/workflows/ci.yml` (name `CI`, `:1`) | `pull_request` for every branch and `push` to `main` (`:3-6`) | two jobs, `check` (`:18`) and `contracts` (`:129`), sections 5.2 to 5.4 |
| `.github/workflows/claude-code-review.yml` | `pull_request` of type `opened`, `synchronize`, `ready_for_review` or `reopened` (`:3-5`) | one job that runs an automated review on the pull request and posts inline comments (section 5.5) |
| `.github/workflows/claude.yml` | a created issue comment, a created pull-request review comment, an opened or assigned issue, a submitted pull-request review (`:3-11`), and only when the text contains the assistant's mention handle (`:15-19`) | one job that carries out the request in the comment (section 5.5) |

`ci.yml` limits the token to read access to the contents (`permissions: contents: read`, `:8-9`) and cancels a still-running run of the same pull request when a new commit arrives; runs on `main` are never cancelled (`concurrency`, `:13-15`; `cancel-in-progress` is true only for `pull_request` events). The two check runs that appear on a pull request are named after the jobs: `typecheck, architecture, tests (with Postgres 18)` (`ci.yml:19`) and `contracts (compile, tests, ABI drift)` (`ci.yml:130`). Neither job has a `paths` filter, so both run for every change, including a documentation-only one.

### 5.2 Job `check`: typecheck, architecture, tests

The job runs on `ubuntu-latest` with a 20-minute limit (`ci.yml:20-21`).

**Database.** A service container `postgres:18-alpine` with user `vistablox`, password `vistablox` and database `vistablox_test` on port 5432, health-checked with `pg_isready` every 5 s, up to 20 retries (`ci.yml:27-40`). The comment at `ci.yml:23-26` calls it a throwaway database that lives only for the job and is never a real environment (AD-257).

**Environment.** Five variables, all placeholders (`ci.yml:46-51`): `TEST_DATABASE_URL` and `DATABASE_URL` and `DIRECT_DATABASE_URL`, all pointing at the service container's database, `BETTER_AUTH_SECRET` (a dummy string) and `VITEST_JSON_REPORT` (`vitest-report.json`, the path of the report file). The comment at `ci.yml:42-45` says nothing the tests import calls `loadEnvironment()` at import time, so no Didit or SMTP placeholders are needed. This review found no test that reads `DATABASE_URL` or `BETTER_AUTH_SECRET` from `process.env`: the only variable names read from `process.env` in `tests/` are `TEST_DATABASE_URL` and the four `TEST_MINIO_*` names (counted by searching the 283 files). `prisma.config.ts:4-6` reads `DIRECT_DATABASE_URL`, which the two Prisma steps need.

**Steps.**

| # | Step | Command | Notes |
| --- | --- | --- | --- |
| 1 | check out | `actions/checkout@v4` (`ci.yml:54`) | |
| 2 | Node | `actions/setup-node@v4`, Node 22, npm cache (`ci.yml:56-59`) | `package.json:6-8` allows `>=22.0.0`; CI tests Node 22 only |
| 3 | install | `npm ci` (`ci.yml:61`) | installs the root tree, including dev dependencies |
| 4 | Prisma client | `npx prisma generate` (`ci.yml:63-64`) | needed by `npm run typecheck` and by every test that imports the client |
| 5 | migrations | `npx prisma migrate deploy` (`ci.yml:66-67`) | applies the whole history to the empty test database |
| 6 | typecheck | `npm run typecheck` (`ci.yml:71`) | |
| 7 | architecture | `npm run architecture` (`ci.yml:73`) | |
| 8 | tests | `npm test -- --reporter=default --reporter=json --outputFile.json="$VITEST_JSON_REPORT"` (`ci.yml:75-76`) | unit and database integration tests; writes the JSON report the next step reads |
| 9 | skip guard | an inline Node script (`ci.yml:82-122`), `if: ${{ !cancelled() }}` (`ci.yml:83`) | section 5.3 |

Steps 6 to 8 are `npm run check` split in three so that the test step can also write the report (`ci.yml:69-70`). Step 9 runs even when step 8 failed, because of `!cancelled()`; if the test step died before it wrote the report, the guard reports that and fails (`ci.yml:88-91`).

### 5.3 The skip guard

Integration files skip themselves when their variable is missing (section 3.4), so a CI job whose database variable was lost would pass with the integration suites silently skipped. The guard turns that into a failure. Its logic, from the script (`ci.yml:85-122`):

1. If the report file does not exist, print an error annotation and exit 1 (`ci.yml:88-91`).
2. For every test in the report, a test counts as skipped when its status is neither `passed` nor `failed` (`ci.yml:100`). The statuses that fall under that are `skipped` and `todo` (the two the experiment below produced), and by the same test any other non-final status.
3. A test that was not skipped and belongs to a file whose base name ends in `.integration.test.ts` adds one to `integrationRan` (`ci.yml:101`).
4. A skipped test in a file whose base name is in `allowedToSkip` adds one to `allowed`; any other skipped test is recorded as unexpected (`ci.yml:102-104`). `allowedToSkip` has one entry, `minio-disclosure-document-store.integration.test.ts` (`ci.yml:93`), the file that gates on `TEST_MINIO_*`, for which the job has no MinIO service (`ci.yml:78-81`).
5. It prints four lines (`Tests: N total, …`, `DB integration tests executed: N`, `Skipped (allowed, MinIO not configured): N`, `Skipped (unexpected): N`) and appends them to the job summary when `GITHUB_STEP_SUMMARY` is set (`ci.yml:107-116`).
6. It exits 1 when any skip is unexpected or `integrationRan` is zero, with an error annotation for each unexpected skip and for the zero case (`ci.yml:117-121`).

The allowlist matches on the file's base name, not its path, and covers every test in that file. The script is CommonJS (`require`, `ci.yml:86`) and is not in `scripts/`.

Checked by running it. The script block was extracted from `ci.yml:86-121` with its YAML indentation removed and run against a JSON report written by Vitest 4.1.11 for a probe project with three files: one named like the MinIO file whose two tests skip, one other integration-named file with one skipped test, and a unit file with one passing, one `it.skip` and one `it.todo` test. The report held one passing test, four with status `skipped` and one with status `todo`; the guard printed `Tests: 6 total, 1 passed, 0 failed, 5 skipped`, `DB integration tests executed: 0`, `Skipped (allowed, MinIO not configured): 2` and `Skipped (unexpected): 3`, and exited 1 with an annotation for each unexpected skip and `No DB integration test executed.` This shows the logic above; it does not show a run against the real suite.

What the guard does not see: a file that yields no tests (a file that fails to import has no assertion results; the test step itself fails then), a file that runs only some of its tests, and the number of integration files that ran, since one executed integration test satisfies it. It does not count `tests/device-auth-dpop-replay-integration.test.ts`, whose name does not end in `.integration.test.ts` (section 2.1). Because `.skip` and `.todo` in any file count as unexpected skips, adding one anywhere fails CI; no test file contains either today (section 3.1).

> Pending #229: its opt-in `tests/clamav-scanner.integration.test.ts` skips unless `CLAMAV_TEST_HOST` is set and is not in the allowlist, so the guard step of that pull request's own check run failed while the typecheck, architecture and test steps passed (read from the run's step list through the GitHub API, not reproduced).

### 5.4 Job `contracts`: compile, tests, ABI drift

The job runs on `ubuntu-latest` with a 15-minute limit (`ci.yml:131-132`). It needs no database, no secret and no root `npm ci` (`ci.yml:124-128`).

| # | Step | Command | Notes |
| --- | --- | --- | --- |
| 1 | check out | `actions/checkout@v4` (`ci.yml:135`) | |
| 2 | Node | Node 22, npm cache keyed on `contracts/package-lock.json` (`ci.yml:137-141`) | |
| 3 | install | `npm --prefix contracts ci` (`ci.yml:143-144`) | the contracts tree only |
| 4 | compile | `npm run contracts:compile` (`ci.yml:148-149`) | downloads the Solidity compiler pinned in `contracts/hardhat.config.js`, so it needs outbound network access (`ci.yml:146-147`) |
| 5 | contract tests | `npm run contracts:test` (`ci.yml:151-152`) | four Mocha files (section 4.5) |
| 6 | ABI drift | `npm run contracts:export-abi`, then `git status --porcelain -- src/infrastructure/blockchain/abis`; a non-empty answer prints an error annotation, the changed files and `git diff`, and exits 1 (`ci.yml:158-169`) | the three committed `*.abi.json` files must equal what the compiled contracts produce |

`git status --porcelain` also reports a file the export recreated after it was deleted and a new file, which `git diff` alone would skip (`ci.yml:164-165`). The committed ABIs exist because the Docker build copies `src/` and not `contracts/` (`scripts/export-contract-abis.mjs:4-9`). The job tests the contracts and the ABI files; it does not deploy anything, and `contracts/scripts/deploy.js` is run by no workflow.

### 5.5 The two other workflows

Both are third-party GitHub Actions wrappers around an assistant service; their identifiers (the action, the secret, the mention handle) are cited by line and not spelled out here.

**`.github/workflows/claude-code-review.yml`.** One job (`:14`) on `ubuntu-latest` with read permissions on contents, pull requests and issues plus `id-token: write` (`:21-26`). It checks out with `fetch-depth: 1` (`:29-32`) and runs a published action (`:36`) authenticated by a repository secret named on `:38`, with a prompt that starts a code-review command with the `--comment` flag against the pull request (`:41`) and a tool allowlist limited to creating inline comments (`:42`). The commented-out `paths` filter (`:6-11`) and author filter (`:15-19`) mean it runs for every pull request event of the four types and every author. It posts review comments; it does not run the test suite and does not block a merge by itself.

**`.github/workflows/claude.yml`.** One job (`:14`) with read permissions on contents, pull requests and issues, `actions: read` and `id-token: write` (`:21-26`). It runs only when the issue comment, review comment, review body, or issue body or title contains the assistant's mention handle (`:15-19`), checks out with `fetch-depth: 1` (`:28-31`), and runs the same published action with the same kind of secret (`:35-37`) and `additional_permissions: actions: read` so the assistant can read CI results (`:39-41`). It has no `prompt`, so it follows the instruction in the comment (`:43-44`). What it may do to the repository beyond what the permissions above allow was not checked.

Neither workflow is required by anything in the repository; whether either is a required status check is set in the repository's branch protection, which this review did not read (section 10).

### 5.6 What CI does not run

Each statement below was checked by searching the file or files it names.

- **No production build.** `npm run build` (`tsc -p tsconfig.build.json` after `prisma generate`, `package.json:12`) runs only inside the Docker image (`Dockerfile:17`). `tsconfig.build.json:10` excludes `src/**/*.test.ts`. A build-only error that `tsc --noEmit` does not report would reach the image build. (`ci.yml` searched for `build`: no match.)
- **No container or Compose check.** `docker` does not occur in `ci.yml`. The staging Compose file is only read as text by two tests (section 2.5).
- **No start-up test.** No test starts `src/server.ts` or `src/worker.ts`: no test file contains `child_process`, `spawn(`, `execFile`, `execSync` or `fork(` (searched `tests/`). The wiring tests read them as text instead.
- **No lint and no formatter.** `package.json` has no ESLint, Prettier or Biome dependency and no script for one (searched `package.json`).
- **No dependency audit.** `audit` does not occur in `ci.yml` or in the `Dockerfile`. An earlier read-only audit ran `npm audit` and reported advisories against direct dependencies; its output was not reproduced here and its numbers are not repeated. The security view of those dependencies belongs to [security.md](security.md).
- **No coverage measurement** (section 3.1).
- **No schema-against-migrations drift check.** Nothing in `ci.yml` compares `prisma/schema` with the migrations. An earlier audit reported that `prisma migrate diff` fails on this repository with error P4002 because the foreign key `accounts_better_auth_user_id_fkey` points at `auth_user` in the default schema (`prisma/migrations/20260831154500_better_auth_core/migration.sql:60-63`), a schema that is not in the datasource's `schemas` list (`prisma/schema/schema.prisma:6-9`); this review did not run the command.
- **One PostgreSQL version and one Node version.** PostgreSQL 18 (`ci.yml:29`) and Node 22 (`ci.yml:58`, `:139`) only.
- **No documentation check** beyond the three files pinned by tests (section 2.5).

## 6. How doubles are injected

The suite replaces collaborators in a small number of ways. Which external system is replaced by which double is in [integrations.md](integrations.md#17-what-the-tests-replace); this section is the mechanism.

### 6.1 Ports as objects

Services take their repositories, clients and senders as constructor arguments typed by an interface, and a test passes an object literal of `vi.fn()` members. `fakeKycRepository` (`tests/app.test.ts`, the function that begins `function fakeKycRepository`) lists every method of `KycRepository` with a default return value and lets a test override some. Where a fake implements a large port it is a class in `tests/support`: `InMemorySettlementRepository` (`tests/support/escrow-mint-fakes.ts:358`), `FakeWalletRegistrationRepository` (`tests/support/wallet-registration-fakes.ts:131`).

### 6.2 The whole app and one router

`createApp(dependencies)` takes an `AppDependencies` object (`src/app.ts:256`, `:461`). Only `databaseProbe`, `offeringRepository`, `logger` and `corsOrigins` are required; every other group is optional (`protectedApi?`, `rateLimitStore?`, `idempotencyStore?`, `coinbaseOnrampWebhook?`, and others), so a test mounts exactly the routes it exercises. `tests/app.test.ts:74-77` builds the smallest app with `logger: pino({ level: "silent" })` (22 test files silence the logger the same way, counted by searching for `level: "silent"`).

> Pending #237: `createApp` is split into per-module compose functions under `src/composition` and `src/app.ts` shrinks; no behaviour changes.

58 files import `supertest`. Of them 17 import `createApp`, 38 build a small Express app around one router (`express()`, then `requestContext`, the router and `errorHandler`, the way `tests/device-auth-dpop-replay-integration.test.ts` does) and 3 take their app from a helper in `tests/support` (`buildWalletFreshAuthApp`, `tests/support/wallet-fresh-auth-app.ts:24`). In `buildWalletFreshAuthApp` the real authentication middleware, the real fresh-authentication probe and the real wallet router run; the session resolver and the customer-session repository are fakes, the caller chooses the wallet repository, and every other module is an empty object that `createApp` dereferences only when a request reaches it (`tests/support/wallet-fresh-auth-app.ts:18-23`).

### 6.3 Options that name the double

| Mechanism | Where the seam is | How tests use it |
| --- | --- | --- |
| A `fetch` option | `HttpDiditClient` (`src/modules/identity/infrastructure/didit.client.ts:74`), `HttpCoinbaseCdpClient` (`src/modules/offering/infrastructure/http-coinbase-cdp.client.ts:98`), `createDeadLetterAlertWebhook` (`src/shared/jobs/dead-letter-alert-webhook.ts:68`) | the test passes a `vi.fn()` that resolves a `Response` (`tests/didit-client.test.ts:10-27`); the client under test is the real class |
| A clock function | constructors that take `clock: () => Date`, for example `src/modules/identity/application/kyc-display-profile.service.ts:16` | 16 test files contain a `clock` option or call (counted by pattern); the real services run on a chosen time |
| A global stub | `vi.stubGlobal("fetch", …)` in one file, `tests/http-android-attestation-revocation-list.test.ts:16`; `vi.mock` of `nodemailer` in `tests/smtp-email-sender-device-replacement-code.test.ts:5` and `tests/smtp-email-sender-recovery-completed.test.ts:5`; `vi.mock` of the Android attestation verifier module in `tests/customer-recovery-completion.integration.test.ts:12` | the three `vi.mock` call sites are the only ones in the suite (searched all 283 files) |
| Fake timers | `vi.useFakeTimers({ toFake: ["Date"] })` with `vi.setSystemTime` in one file, `tests/better-auth-device-session-lifetime.plugin.test.ts:97-98` | only `Date` is faked, and only in this file |
| A stub JSON-RPC node | `serveTransferWorld` (`tests/support/transfer-chain-world.ts:217`) starts an `http` server; `tests/chain-client.test.ts` points real `viem` clients at it | the answers depend on the block an `eth_call` is pinned to |
| An in-process lock | `InProcessOperatorKeyLock` implements `OperatorKeyLock` (`tests/support/operator-key-lock-fakes.ts:9`) | settlement services run without PostgreSQL; the real lock has its own integration test (`tests/operator-key-lock.integration.test.ts`) |
| Real cryptography | `createSoftwareAuthenticator` (`tests/support/software-authenticator.ts:19`); certificate chains built inside `tests/android-attestation-verifier.test.ts` | no mock of the verification; the relying party's checks run on genuine signatures |
| A real database client | `createPrismaClient(databaseUrl ?? "")` in 47 integration files (counted by searching for `createPrismaClient`), a `pg` pool, and `new PgBoss(...)` in 18 | section 4 |
| Real Better Auth | `createBetterAuth` from `better-auth.factory.ts` is imported by 25 test files, 13 of them integration files (counted by searching for the import path) | for example `tests/staff-bootstrap-repository.integration.test.ts:17-24` builds it over a `pg` pool with `allowPopulationInput: true` |
| Failure injection into the database client | `withWriteHooks` (`tests/support/wallet-registration-db.ts:32`) and `deferred` (`:10`) | pause or fail one write inside a repository's own transaction |

`vi.mock` is therefore rare, and what is replaced is almost always passed in, not patched in.

## 7. Conventions for writing a test

The first table says what a rule is backed by, so a reader can tell a rule that fails the build from a habit of the existing suites. The sections after it describe the habits.

| Rule | Backed by |
| --- | --- |
| Test code type-checks under `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` | `npm run typecheck` includes `tests/` (`tsconfig.json:7-9`, `:16`), CI step 6 |
| No `.only` | the run fails when `CI` is set (section 3.1) |
| No skipped test except in the MinIO file | the CI skip guard (section 5.3) |
| A database suite lives in a file named `*.integration.test.ts` | the guard counts executed integration tests by that suffix (`ci.yml:101`), and the isolation tests find files by it |
| Only the health integration test touches the wallet-registry heartbeat and cursor rows | `tests/wallet-registry-heartbeat-isolation.test.ts:30-52` |
| The bootstrap and expiry suites run alone and last | `vitest.config.ts:31-41`, `tests/staff-bootstrap-isolation.test.ts` |
| Source modules obey the layering rules | `npm run architecture` (`tests/` is not scanned) |
| Everything else in this section | habit only |

### 7.1 Choosing the kind of test

- A pure function or policy: a unit test that calls it with literal input (`tests/intake-entry-policy.test.ts:19-36`).
- A service with ports: a unit test with `vi.fn()` ports (section 6.1).
- An HTTP route: `supertest` against a small Express app that mounts `requestContext`, the router and `errorHandler`, so the error envelope is the real one (38 files); or against `createApp` when the middleware order matters (17 files).
- SQL, transactions, row locks, constraints and migrations: an integration test. A test with fake repositories cannot see these; `tests/platform-settings-seed.test.ts:7-12` records a defect of that kind that went through CI because no real-database test read the setting.
- The wiring of `src/server.ts` or `src/worker.ts`: a text test through `withoutComments` (section 2.5).
- An external system: there is no real one in the suite; inject a double (section 6.3).

### 7.2 The shape of a database test

The 54 database files follow one pattern. Written out (the identifiers are those of `tests/offering-presentation.integration.test.ts:12-35` and `:67-76`; the file is a pattern, not an API):

```ts
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("<subject> PostgreSQL integration", () => {
  const suffix = randomUUID();                       // every id ends with it
  const accountId = `account_<subject>_${suffix}`;
  const database = createPrismaClient(databaseUrl ?? "");
  let boss: PgBoss;                                  // only if the code enqueues jobs

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");            // built here, not in the describe body
    // insert the fixture rows
  });

  afterAll(async () => {
    // delete the fixture rows, child tables first
    await database.$disconnect();
  });

  it("…", async () => { /* … */ });
});
```

- **Ids.** Every row id carries the `randomUUID()` suffix, so parallel files and re-runs do not collide (`tests/offering-presentation.integration.test.ts:15-24`). 62 test files use `randomUUID`, `ulid` or `randomBytes` (counted by searching the 296 files).
- **An account needs a Better Auth user.** `accounts.better_auth_user_id` has a real foreign key to `auth_user` (`prisma/migrations/20260831154500_better_auth_core/migration.sql:60-63`), so a test inserts an `auth_user` row first (`tests/offering-presentation.integration.test.ts:35-37`) or creates one through Better Auth's adapter (`tests/staff-bootstrap-repository.integration.test.ts:31-34`) and deletes it last (`tests/offering-presentation.integration.test.ts:74`).
- **Slow setup.** A hook that does real work gets an explicit timeout as its last argument, `beforeAll(async () => { … }, 30_000)` (`tests/job-dead-letter.integration.test.ts:77-83`).
- **Queues.** A test that needs real queue behaviour gives pg-boss a private schema and drops it afterwards (section 4.3).
- **No global assertions.** The files share one database and run at once, so a test asserts on its own rows and not on a table's total or "the oldest" row. The suites that must look at global state are the two that run alone, and the one owner of the watcher rows.

### 7.3 Time, randomness and logs

- Services take `clock: () => Date`; a test passes a chosen time instead of faking timers (section 6.3). Only `tests/better-auth-device-session-lifetime.plugin.test.ts` fakes `Date`.
- A date that must be in the future for any realistic run is written far ahead, for example `2099-12-31T00:00:00.000Z` (15 test files contain a `2099-` date) or computed from `Date.now()` (`tests/signing-requests-router.test.ts:20-21`).
- Application loggers are silenced with `pino({ level: "silent" })` (22 files). Tests that assert on log lines build a capturing logger (`makeCapturingLogger`, `tests/support/escrow-mint-fakes.ts:328`).
- Test values for secrets and keys are made-up strings in the test file or a support constant; the suite reads no secret from the environment.

### 7.4 Titles

`it.each` titles take `%s` for the row, so each row has its own name (`tests/removed-customer-factors.integration.test.ts:17-18`). Two places do not, and the names then repeat (section 8, item 8).

### 7.5 Adding a suite that must run alone

Add its path as a constant and a project with `include` and a later `sequence.groupOrder` next to the two that exist (`vitest.config.ts:9`, `:14`, `:33-40`), and extend `tests/staff-bootstrap-isolation.test.ts` so the new placement is asserted. State why in a comment, as the two existing ones do (`vitest.config.ts:3-8`, `:10-13`).

### 7.6 Before a change is called done

`npm run check` passes (`AGENTS.md:9`), ideally with `TEST_DATABASE_URL` set to a local PostgreSQL 18 test database; if the integration suites were skipped the report says so (`AGENTS.md:10`). A change is a pull request opened with `gh pr create`, not merged by its author (`AGENTS.md:26-27`).

## 8. Known limitations

Each item is stated as the code stands on main. None is fixed by this documentation. The issue map (`issues.json` of the earlier audit) has no entry for any of them, so none carries an issue number.

1. **Nine integration files pass only in definition order.** An earlier audit ran the suite with the tests inside each file shuffled and nine integration files failed that run, though all passed in default order: `wallet-registry-health`, `offering-document-upload`, `offering-wallet-readiness`, `staff-intake-case-repository`, `ipo-escrow-campaign-readiness`, `account-recovery-repository`, `device-session-supersede`, `offering-presentation` and `profile-wallet-activity-repository` (all `tests/<name>.integration.test.ts`). Each of the nine calls `beforeAll` once (counted by pattern); `wallet-registry-health` also calls `beforeEach` twice, the other eight never. The audit did not trace each failure to its cause. Shuffling only the order of files passed. CI sets no `sequence.shuffle` (`vitest.config.ts`), so none of this fails CI. Not reproduced here.
2. **Fixtures that depend on the calendar.** The certificates built in `tests/android-attestation-verifier.test.ts:201`, `:222`, `:333`, `:401`, `:415`, `:439` and `tests/device-enrolment-service.test.ts:281`, `:295` carry `notAfter: new Date("2035-01-01")`; a chain is expired once the clock passes that date, and an earlier audit that shifted the JavaScript clock forward by 3,650 days saw tests in those two files fail (not reproduced). `tests/signing-requests-router.test.ts:191` builds an expired request from the literal `2026-09-01T09:59:00.000Z` and passes only while the real clock is later; the same audit saw it fail with the clock shifted back 400 days. The clock-shift run covered unit tests only.
3. **Real-clock tests and counts.** No fake clock is the norm: `new Date()` with no argument occurs 188 times in 34 files, `Date.now(` 89 times in 38 files, `setTimeout` 21 times in 13 files, and a date-time literal of the form `YYYY-MM-DDTHH:MM:SS` 880 times in 164 files (all counted by pattern over the 296 files of `tests/`; an earlier audit counted the last figure with another pattern and got 789). Fake timers are used in one file.
4. **Wall-clock bounds and short sleeps.** `tests/transfer-snapshot.test.ts:441` asserts that a call with a 100 ms budget returns in under 280 ms and `:657` that a call that makes a second attempt returns in under 180 ms; `tests/device-enrolment-insert-deadline.integration.test.ts:165` bounds a wait at 15 s and `:209-210` requires between 5 s and 9 s; `tests/wallet-fresh-authentication-api.test.ts:61` requires a timestamp within 5 s of `Date.now()`. Several tests prove that a call is still blocked by racing it against a short timer: 300 ms at `tests/wallet-registration-evidence.repository.integration.test.ts:392`, `:508`, `:563` and `tests/wallet-reconcile-evidence.repository.integration.test.ts:261`, `:349`; `stillPendingAfter` at `tests/intake-reversal.integration.test.ts:47-58`; sleeps of 10 to 100 ms at `tests/operator-key-lock.integration.test.ts:30`, `:60`, `:137`, `:156` and `tests/settlement-escrow-gate.integration.test.ts:366`; 5 ms ticks that separate timestamps at `tests/device-session-supersede.integration.test.ts:190` and `tests/better-auth-device-session-supersede.test.ts:49`. An earlier audit repeated the transfer-snapshot suite with and without CPU load and could not make it fail (not reproduced); a heavily loaded runner is the case it did not cover.
5. **Leftover jobs in the shared database.** Fifteen integration files build pg-boss on the default `pgboss` schema and no test deletes the jobs they enqueue (section 4.3). An earlier audit found jobs left in state `created` after its runs and saw a worker started on that database consume some within seconds; the throwaway CI database hides this. Not reproduced here.
6. **Shared-database coupling is held together by comments and two tests.** 281 files share one database and run at once. The rules that keep them apart are the two serialised projects (`vitest.config.ts:3-14`), the single owner of the wallet-registry rows (`tests/wallet-registry-heartbeat-isolation.test.ts`), and the habit of unique ids (section 7.2). A new test that reads or deletes a table-wide or settings row is not caught by any rule.
7. **A skipped run looks like a pass.** `npm test` exits 0 with every database suite skipped (`README.md:145`); only the CI skip guard turns that into a failure, and it exists only inside `.github/workflows/ci.yml` (section 5.3). An empty `TEST_DATABASE_URL` does not skip (section 3.4). A local run's summary is the only evidence that the database suites ran.
8. **Two repeated test titles.** `tests/intake-entry-policy.test.ts:35` is an `it.each` of seven rows with the fixed title `rejects a failed prerequisite`, so seven cases share one name. `tests/investor-offering-repository.integration.test.ts:1686`, `:2645` and `:2811` are three `it` blocks with the title `reports offering_not_found for an unknown offering` in one `describe` (the file's four top-level `describe` blocks start at `:18`, `:364`, `:1174`, `:3022`), so `-t` selects all three and a result keyed by name cannot tell them apart.
9. **CI covers one fresh path.** The test database is empty and receives every migration in one `prisma migrate deploy` (`ci.yml:66-67`); no job upgrades a database from an earlier state, runs a schema-against-migrations comparison, or builds the image (section 5.6). `prisma/migrations` has two directories with the stamp `20260918100000` (`reservation_client_idempotency` and `room_photo_associations`) and one stamped `20261121090000` (`escrow_mint_intent_nonce`), later than the commit date of main and committed on 2026-11-16 (`git log` of that directory). A migration stamped between those dates sorts before it on a fresh database and after it on an existing one. An earlier audit applied such an out-of-order migration to a throwaway database and found that `migrate deploy` accepted it (not reproduced).
10. **No test starts the two processes.** `src/server.ts` and `src/worker.ts` run their work when imported, so the wiring tests read them as text (`tests/coinbase-onramp-webhook-wiring.test.ts:8-10`). A change that leaves the text intact and breaks start-up is not caught by the suite.
11. **Doubles can hide a wrong wire format.** No test constructs `ClamAvScanner` (searched `tests/` for the name: no match); the upload tests inject a stub that implements `MalwareScanner`, so the scanner's wrong command bytes ([integrations.md](integrations.md#7-clamav), issue #205) had no test to fail. The same holds for `GooglePlayIntegrityDecoder`, constructed by no test, and for every provider that is replaced by a fake `fetch` or a stub; see [integrations.md](integrations.md#17-what-the-tests-replace).

> Pending #225: adds a wire-format unit suite for `ClamAvScanner` against a fake `clamd` on a socket, and an opt-in `npm run clamav:smoke` command for a real `clamd`.

12. **The coverage block names a provider that is not installed and the report file is not ignored.** `vitest.config.ts:25-28` configures `v8` coverage while neither `package.json` nor a package entry in `package-lock.json` provides the coverage package (section 3.1). The CI command writes `vitest-report.json` in the working directory, and `.gitignore` does not list it (`.gitignore:1-11`), so the same command run locally leaves an untracked file.
13. **Two variables name one database.** Migrations apply to `DIRECT_DATABASE_URL` (`prisma.config.ts:4-6`) and the tests read `TEST_DATABASE_URL`; nothing checks that they name the same database, so a test run against a database that was not migrated fails with missing tables and not with a configuration message. (Reasoned from the two reads; not run.)

**Known gaps against the design record.** Where the code and the record disagree, the record wins and the conflict is stated, not resolved (`AGENTS.md:5`). The record is the sibling repository `vistablox-design-docs`, read at its checkout at commit 65d4ee9; nothing in it was edited. The register is `00-Governance/MIGRATION/CONFLICT_REGISTER.md`; it has no entry for any row below (searched for `msw`, `fast-check`, `E2E`, `INTEGRATION_TESTS`, `MOCKING_PATTERNS`, `TEST_STRATEGY` and `UNIT_TESTS`: no match).

| Subject | Record | Code |
| --- | --- | --- |
| Mocking providers | `04-Engineering/QUALITY/MOCKING_PATTERNS.md:20-37` says every provider is mocked at the HTTP boundary with `msw`, not at the client wrapper | `msw` is not in `package.json` and has no package entry in `package-lock.json` (the name occurs there only as an optional peer dependency of `@vitest/mocker`, `package-lock.json:3316`, `:3320`); tests pass a fake `fetch` into the real client or a stub of the client interface (section 6.3) |
| Property-based tests | `04-Engineering/QUALITY/UNIT_TESTS.md:87-90` recommends `fast-check` for invariants | `fast-check` is not a dependency in `package.json` and no test imports it (searched `tests/`); the lockfile lists it once as an indirect `devOptional` entry (`package-lock.json:4689`, required at `:4442`) |
| End-to-end tier | `04-Engineering/QUALITY/E2E_TESTS.md:20-30` and `04-Engineering/QUALITY/TEST_STRATEGY.md:56` describe three critical-path tests over real HTTP against a running API | no test starts the API (section 5.6) and `tests/` has no end-to-end file or helper; those flows are covered by service, router and repository tests |
| Queue helper | `04-Engineering/QUALITY/INTEGRATION_TESTS.md:75` shows a helper that drains pg-boss synchronously | `tests/` has no such helper (searched for `runWorkerUntilQueueEmpty`: no match); queue behaviour is tested with a real pg-boss instance in `tests/job-dead-letter.integration.test.ts` |
| Coverage | `04-Engineering/QUALITY/TEST_STRATEGY.md:58-60` says a numeric coverage percentage is tracked as a secondary signal | coverage is not measured (section 3.1) |
| CI gate | `04-Engineering/QUALITY/TEST_STRATEGY.md:58-60` says the suite runs in GitHub Actions on every push before merge and that a failure of the first tier blocks the merge | `ci.yml` runs on every pull request and on pushes to `main` (`ci.yml:3-6`); whether a failure blocks a merge is a branch-protection setting that was not read |
| The existence of CI | AD-257 (`00-Governance/DECISIONS/ARCHITECTURE_DECISIONS.md:2171`, `:2177`) states that `vistablox-api` has no CI workflow and no `.github/workflows` directory | `.github/workflows/ci.yml` exists on main and provisions its own PostgreSQL 18 service container, the direction AD-257 names |

## 9. Related documents

- [integrations.md](integrations.md): what each external system is replaced with in tests ([section 17](integrations.md#17-what-the-tests-replace)), and the defects the doubles hide.
- [architecture.md](architecture.md): the layering rules that `npm run architecture` enforces.
- [jobs-and-workers.md](jobs-and-workers.md) and [dead-letter-jobs.md](dead-letter-jobs.md): the queues that the source-text tests pin and the dead-letter flow that `tests/job-dead-letter.integration.test.ts` exercises.
- [configuration.md](configuration.md): the variables, including the `TEST_*` names, and the staging anchor that `tests/wallet-registry-alert-config.test.ts` reads.
- [operations.md](operations.md): the deployment, which no workflow performs.
- [data-model.md](data-model.md): the migrations the integration suites run against.
- [security.md](security.md): dependency advisories and the secrets used by CI.
- [wallet-registration-operations.md](wallet-registration-operations.md) and [investor-profile.md](investor-profile.md): two guides whose text is pinned by tests.
- [README.md](../README.md), "Testing", and [AGENTS.md](../AGENTS.md), "Commands": the shorter statements of the same rules.

## 10. Not verified

- **The suite was not run.** No unit or integration test was executed for this chapter and no database command was run. Counts of files are made by script over `git ls-files tests` at 48aa967; counts of occurrences are made by pattern and the pattern is named where the number is used. An earlier read-only audit ran `npm run check` on a freshly migrated local database and reported a clean run, repeated runs with identical outcomes, and the shuffle and clock-shift experiments cited in section 8; those results were used as leads, not repeated, and none of their timings or test totals is quoted here.
- **PostgreSQL 18.** CI and the compose files use PostgreSQL 18 (`ci.yml:29`, `docker-compose.yml:3`); the earlier audit's local runs used 16.15. The commands in section 4.2 were not run on either.
- **GitHub behaviour.** What GitHub does with the workflows (that `CI` is set to `true` on its runners, that a failed check blocks a merge, which checks are required) is not in the repository. Branch protection and required checks were not read. The step list of one failed check run (the check of #229's head commit) was read through the GitHub REST API; no other run's log was read.
- **The two assistant workflows.** What they may do beyond their declared permissions, and the contents of the secret they read, were not checked.
- **Library behaviour.** The Vitest defaults and the sort by `groupOrder` are cited from an installed copy of `vitest` 4.1.11 whose version equals the one `package-lock.json` locks; the resolved configuration was produced with `createVitest` on a copy of `vitest.config.ts` in a scratch directory, not in the checkout. The `.env` behaviour, the `.only` behaviour and the report statuses were checked on probe projects in a scratch directory.
- **Contract tests and the ABI job.** `npm run contracts:compile`, `contracts:test` and the ABI drift step were not run; they need the contracts dependency tree and the compiler download.
- **Order and timing findings.** Items 1, 2, 4 and 5 of section 8 rest on the earlier audit's experiments and on reading the code; none was reproduced here.
