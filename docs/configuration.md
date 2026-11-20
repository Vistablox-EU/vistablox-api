# Configuration reference

Valid for main at 48aa967 (2026-11-18).

Every environment variable that the API, the worker and the command-line tools read: its type, default and constraints, which process reads it, when it is required, and where a value for it is set in the local, CI and staging setups. The readers are the operator who fills in `.env` or `.env.staging` and the engineer who adds a variable. Images, compose services and the deploy flow are in [operations.md](operations.md); what each feature does is in the chapter named in the "Described in" column of section 3.

Citations are `(path:line)` at 48aa967; the function or identifier is named next to the number because line numbers drift. A path that starts with `00-Governance` or `04-Engineering` is in the design-record repository (`vistablox-design-docs`). A statement that could not be checked is written as `Not verified: ...`, and section 9 collects the reasons. Counts in this chapter (97 schema variables, 12 required, 34 not in the staging anchor) come from scripts run over the files at 48aa967. Register entries (`00-Governance/MIGRATION/CONFLICT_REGISTER.md`, used in section 8) are read from the `main` branch of the design-record repository at commit eadf224 (2026-11-18); a local checkout of that repository on an older branch holds only C-001 to C-008.

Contents: [1 How configuration is loaded](#1-how-configuration-is-loaded) · [2 Variable reference by group](#2-variable-reference-by-group) · [3 Where each variable is set](#3-where-each-variable-is-set) · [4 Boot-time rules](#4-boot-time-rules) · [5 Which variables switch which feature](#5-which-variables-switch-which-feature) · [6 How a variable reaches the staging containers](#6-how-a-variable-reaches-the-staging-containers) · [7 NODE_ENV and APP_ENV](#7-node_env-and-app_env) · [8 Known limitations](#8-known-limitations) · [9 Not verified](#9-not-verified) · [10 Related documents](#10-related-documents)

## 1. How configuration is loaded

### 1.1 One schema, six entry points

The schema is `environmentSchema`, a Zod object with 97 top-level keys (`src/config/environment.ts:6-390`) followed by 18 cross-field rules (`.refine(...)`, `src/config/environment.ts:391-646`). `loadEnvironment()` parses `process.env` against it and returns the typed object (`src/config/environment.ts:650-652`). Six entry points call it once, near the top of their file, and receive the whole object:

| Entry point | File | `loadEnvironment()` | `import "dotenv/config"` |
| --- | --- | --- | --- |
| API | `src/server.ts` | `:98` | `:1` |
| Worker | `src/worker.ts` | `:72` | `:1` |
| `staff:bootstrap-first-admin` | `src/cli/bootstrap-first-admin.ts` | `:63` | `:17` |
| `jobs:replay-dead-letter` | `src/cli/replay-dead-letter-job.ts` | `:46` | `:13` |
| `settlement:open-ipo-escrow-campaigns` | `src/cli/open-ipo-escrow-campaigns.ts` | `:59` | `:16` |
| `intake:backfill-events` | `src/cli/backfill-intake-case-events.ts` | `:50` | `:8` |

Three other files read configuration without this schema (section 2.19): the bucket initialiser parses its own small schema (`src/infrastructure/storage/ensure-minio-bucket.ts:9-18`), `prisma.config.ts` reads `DIRECT_DATABASE_URL` (`prisma.config.ts:4-6`), and the Hardhat package under `contracts/` reads its own variables (`contracts/hardhat.config.js:29-35`).

Because every entry point parses the whole schema, every one of them needs the 12 variables that have neither a default nor `.optional()`: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_CALLBACK_URL`, `DIDIT_WEBHOOK_SECRET`, `DIDIT_APPLICATION_ID` and `DIDIT_ENVIRONMENT` (`src/config/environment.ts:14`, `:18`, `:159`, `:165-167`, `:242-247`). A script found that `src/server.ts` reads 70 distinct names through `environment.<NAME>`, plus 7 more through helper functions that receive the whole object (`resolveWebAuthnSettings`, `resolveStaffInvitationAcceptUrl`, `isSettlementBundleConfigured`); the same script found that `src/worker.ts` reads 41. The "Read by" column in section 2 is the per-variable answer. The following are required by the schema in a process that never reads them:

| Process | Required but never read |
| --- | --- |
| Worker | `BETTER_AUTH_SECRET`, `DIDIT_CALLBACK_URL`, `DIDIT_WEBHOOK_SECRET` (`src/worker.ts:98-102` and `:158-170` read the other Didit values) |
| API | `DIDIT_APPLICATION_ID`, `DIDIT_ENVIRONMENT` (read only in `src/worker.ts:163-164`) |
| `jobs:replay-dead-letter`, `intake:backfill-events`, `settlement:open-ipo-escrow-campaigns` | the first two read only `DATABASE_URL` (the replay command also `LOG_LEVEL`); the third reads `DATABASE_URL`, `LOG_LEVEL` and the `CHAIN_*` settings and addresses; every other variable is validated only (`src/cli/replay-dead-letter-job.ts:46-51`, `src/cli/backfill-intake-case-events.ts:50`, `src/cli/open-ipo-escrow-campaigns.ts:59-69`) |

`import "dotenv/config"` reads a file named `.env` in the working directory before the schema is parsed. A variable that is already in the process environment is not replaced by the file (checked with `dotenv` 17.2.3, the version in `package.json:45`, with a two-line script outside the repository). The images contain no `.env`: `.dockerignore:6-8` excludes `.env` and `.env.*` except `.env.example`. In the local compose stack, `.env` is handed to the API and the worker as an `env_file` (`docker-compose.yml:103-104`, `:148-149`).

### 1.2 What happens when a value is wrong

`loadEnvironment()` calls `environmentSchema.parse(source)` and nothing catches the result in the API, the worker or any command (`src/server.ts:98`, `src/worker.ts:72`, `src/config/environment.ts:650-652`). A failure is an uncaught `ZodError`: the process prints the error and ends with exit code 1. Observed with a probe that loaded a copy of `src/config/environment.ts` with only `NODE_ENV=production` set: exit code 1, a stack trace, and a JSON array of 12 issues, one for each variable in the list above. The issues carry the variable name and a message; they do not carry the value (a second probe with wrong values for five variables printed only the names).

The two kinds of rule report at different times. A missing or wrongly typed value (a required variable that is absent, a value that is not one of an enum's members) is reported first, and while any of those exist the cross-field rules of section 4 do not run. A value that fails a range or format check does not stop the cross-field rules. Probe evidence: with the 12 variables absent the output has 12 issues and no cross-field message; with `PORT=0`, `GOOGLE_OAUTH_ENABLED=true` and `NODE_ENV=production` and the 12 variables present, the output lists the `PORT` range issue, the Google credentials rule and the Play Integrity rule together. In practice an operator fixes the missing variables, starts the process again, and then sees the cross-field messages.

In staging the worker and the API have `restart: unless-stopped` (`docker-compose.staging.yml:257`, `:284`), so a process that fails to parse its environment is started again by Docker and fails again until the file is fixed. The deploy script validates the compose file but not the application's schema (`scripts/deploy/staging.sh:18`).

### 1.3 Blank values

An empty string is a value, not an absence, unless the schema says otherwise. A script set each of the 97 variables to `""` one at a time (all required variables otherwise valid) and recorded the outcome.

| Outcome with `VAR=` (blank) | Variables |
| --- | --- |
| Treated as unset (accepted) | `DPOP_PHASE1_CUTOVER_AT`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `PASSKEY_APPLE_TEAM_ID`, `PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS`, `PASSKEY_ANDROID_ORIGINS`, `STAFF_INVITATION_ACCEPT_URL`, `STAFF_RECOVERY_REDIRECT_URL`, `ACCOUNT_RECOVERY_REDIRECT_URL`, `APP_ENV`, `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER`, `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON`, `ANDROID_ATTESTATION_CERT_DIGESTS`, `ANDROID_ATTESTATION_ROOT_CERTIFICATES`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `RATE_LIMIT_CACHE_URL`, `TRUST_PROXY`, `PROFILE_CACHE_URL`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, the five `MINIO_*_BUCKET` names, `CLAMAV_HOST`, `DIDIT_POA_WORKFLOW_ID`, `COINBASE_CDP_API_KEY_ID`, `COINBASE_CDP_API_KEY_SECRET`, `COINBASE_ONRAMP_REDIRECT_URL`, `COINBASE_ONRAMP_WEBHOOK_SECRET`, `CHAIN_NETWORK`, `CHAIN_RPC_URL`, `CHAIN_OPERATOR_PRIVATE_KEY`, the four contract and treasury addresses, `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS`, `DEAD_LETTER_ALERT_WEBHOOK_URL` |
| Replaced by the default (accepted) | `WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES`, `WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS`, `WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT`, `WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT`, `WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS`, `WALLET_REGISTRY_PENDING_EXPIRE_SWEEP_MINUTES`, `WALLET_REGISTRY_PENDING_EXPIRE_BATCH_SIZE`, `ESCROW_MINT_NONCE_BLOCK_TAG` (these use `blankTolerantInteger` or an explicit preprocess, `src/config/environment.ts:324-372`, `:805-807`) |
| Accepted, and not the default | `AUTH_TRUSTED_ORIGINS`: a blank value gives an empty list, not `http://localhost:3000` (`src/config/environment.ts:135-138`) |
| Refused (boot fails) | `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`, `BETTER_AUTH_URL`, `WEBAUTHN_RP_NAME`, `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE`, `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING`, `PLAY_INTEGRITY_POLICY`, `GOOGLE_OAUTH_ENABLED`, `APPLE_OAUTH_ENABLED`, `SMTP_PORT`, `SMTP_SECURE`, `MINIO_PORT`, `MINIO_USE_SSL`, `CLAMAV_PORT`, `DIDIT_API_BASE_URL`, `COINBASE_CDP_API_BASE_URL`, `COINBASE_CDP_PAY_HOSTED_URL`, `COINBASE_ONRAMP_BLOCKCHAIN`, `RESERVATION_FUNDING_RAIL_ENABLED`, `OPERATING_DISTRIBUTION_ENABLED`, `WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES`, `KYC_CREATING_ALERT_AFTER_MINUTES`, `KYC_OPEN_ALERT_AFTER_MINUTES`, `ACCOUNT_RECOVERY_ALERT_AFTER_HOURS`, the four `DEVICE_REPLACEMENT_*`, and the twelve required variables |

A value of only spaces is refused for `DEAD_LETTER_ALERT_WEBHOOK_URL` and `TRUST_PROXY` and treated as unset for `WEBAUTHN_ORIGIN` (probe). The staging anchor protects the variables it lists with `${NAME:-default}` entries (`docker-compose.staging.yml:140-247`); a variable that reaches a container only through `.env.staging` has no such protection (section 6).

### 1.4 Why the count is 97 and more names appear in this chapter

The environment schema has 97 variables. The 97 are the keys of the object passed to `z.object` in `src/config/environment.ts:6-390` (97 keys, counted by script, none repeated). Nine further names are not in the schema (`DIRECT_DATABASE_URL`, `TEST_DATABASE_URL`, `EMAIL_VERIFICATION_ENABLED`, `POSTGRES_PASSWORD`, `DEPLOYER_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL`, `VISTABLOX_BASE_URI`, `VITEST_JSON_REPORT`). Further names outside the schema (names that exist only in the compose files, the Dockerfiles, `tests/`, `contracts/` or the design record) are listed with the nine in section 2.19. Of the 97, two are absent from `.env.example` (`CLAMAV_HOST`, `CLAMAV_PORT`), and `.env.example` itself carries two names that are not in the schema (`DIRECT_DATABASE_URL`, `TEST_DATABASE_URL`) (`.env.example:285`, `:292`).

> Pending #238: removes `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` from the schema, so the count of 97 variables and the counts of variables with a schema default (section 1.3; L13 and L14 in section 8) change.

> Pending #241: adds `DEAD_LETTER_ALERT_WINDOW_MINUTES` to the schema with a default of 60, so the same counts change.

## 2. Variable reference by group

Each table lists the variable, its type, constraint and default with the schema line, who reads it, and what it means to leave it unset. "Read by" names the process (api, worker, cli) with the line where the value is used; a variable that every process only validates is marked "validated only". A line citation of the form `src/config/environment.ts:N` points at the start of the key's declaration. Section 3 repeats every name once more with the files that set it.

### 2.1 Server and environment tier

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production`; default `development` (`src/config/environment.ts:8`) | api (`src/server.ts:208`, `:225`, `:313`, `:374`, `:672`); cli `staff:bootstrap-first-admin` (`src/cli/bootstrap-first-admin.ts:74`); three cross-field rules in every process (`src/config/environment.ts:571-580`, `:581-592`, `:611-628`) | Never required. Only the value `production` is compared anywhere; `test` behaves like `development`. The api and worker images set `production` (`Dockerfile:33`, `:44`). Unset means `development`, which skips every production-only rule (section 7). |
| `APP_ENV` | `staging` \| `production`; blank is unset; no default (`src/config/environment.ts:99`) | cross-field rules only (`src/config/environment.ts:553-561`, `:562-570`, `:581-592`); nothing outside `src/config/environment.ts` reads it | Never required. Unset means production. `staging` is the only value that relaxes anything: it allows `PLAY_INTEGRITY_POLICY` `disabled` or `relaxed`, `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE=true` and `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING=true`. The staging anchor pins it (`docker-compose.staging.yml:154`). Any other spelling (`Staging`) is refused. |
| `HOST` | string, at least 1 character; default `0.0.0.0` (`src/config/environment.ts:9`) | api (`src/server.ts:754`) | Never required. Address the HTTP server binds to. |
| `PORT` | integer 1-65535; default `3000` (`src/config/environment.ts:10`) | api (`src/server.ts:754`) | Never required. Port the HTTP server listens on. The image documents 3000 (`Dockerfile:37`) and both compose files publish 3000 and probe `localhost:3000` (`docker-compose.yml:102`, `:137`, `docker-compose.staging.yml:120`, `:264`), so changing it also needs those lines changed. |
| `LOG_LEVEL` | `fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace` \| `silent`; default `info` (`src/config/environment.ts:11-13`) | api (`src/server.ts:99`), worker (`src/worker.ts:73`), cli `settlement:open-ipo-escrow-campaigns` (`src/cli/open-ipo-escrow-campaigns.ts:68`), cli `jobs:replay-dead-letter` (`src/cli/replay-dead-letter-job.ts:47`) | Never required. Level of the JSON logger (`src/infrastructure/logging/logger.ts:3-5`). The staging anchor passes it with default `info` (`docker-compose.staging.yml:228`). |
| `TRUST_PROXY` | hop count 0-10, or a comma-separated list of IP addresses, CIDR ranges (IPv4 prefix /8 or longer, IPv6 /16 or longer) and the presets `loopback`, `linklocal`, `uniquelocal`; `true`, netmasks and wider ranges are refused; blank is unset (`src/config/environment.ts:183-200`, `:756-796`) | api (`src/server.ts:601`, applied by `src/app.ts:463-465`; start-up warning `src/server.ts:208-212`) | Never required. Unset trusts no proxy: `request.ip` is the connecting address and `X-Forwarded-For` is ignored, so behind a reverse proxy every unauthenticated caller shares one IP rate-limit bucket (`src/app.ts:288-292`). The API logs a `warn` line at start when rate limiting is on, `NODE_ENV` is `production` and this is unset (`src/server.ts:208-212`). The staging anchor passes it with a blank default, so unset stays unset (`docker-compose.staging.yml:166`). |

### 2.2 Database

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `DATABASE_URL` | URL that starts with `postgresql://`; `postgres://` is refused; no default (`src/config/environment.ts:14-16`) | api: Prisma client, the `pg` pool that Better Auth uses and pg-boss (`src/server.ts:100-102`); worker: Prisma client and pg-boss (`src/worker.ts:74`, `:89`); every command (`src/cli/bootstrap-first-admin.ts:64-65`, `src/cli/replay-dead-letter-job.ts:51`, `src/cli/open-ipo-escrow-campaigns.ts:69`, `src/cli/backfill-intake-case-events.ts:50`) | Required in every process. One connection string serves all pools of a process; no variable separates a pooled from a direct connection for the runtime. |

`DIRECT_DATABASE_URL` (migrations) and `TEST_DATABASE_URL` (tests) are not in the schema; see section 2.19.

### 2.3 Authentication

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `BETTER_AUTH_URL` | URL; default `http://localhost:3000` (`src/config/environment.ts:17`) | api: Better Auth base URL, DPoP base URL, device-auth base URL, staff recovery link host (`src/server.ts:140`, `:311`, `:316`, `:372`, `:607`, `:642`, `:738`); cli `staff:bootstrap-first-admin` (`src/cli/bootstrap-first-admin.ts:72`); the WebAuthn rule (`src/config/environment.ts:535-552`) | Never required; a deployed environment sets it. Its hostname must equal `WEBAUTHN_RP_ID` or be a subdomain of it when that is set. The staging anchor does not pass it; it comes from `.env.staging` (section 6). |
| `BETTER_AUTH_SECRET` | string of at least 32 characters; no default (`src/config/environment.ts:18`) | api: Better Auth, session mirror token (`src/server.ts:308`, `:312`, `:373`); cli `staff:bootstrap-first-admin` (`src/cli/bootstrap-first-admin.ts:73`); validated only in the worker | Required in every process. The placeholder in `.env.example` is 42 characters, so it satisfies the length rule (`.env.example:19`). |
| `AUTH_TRUSTED_ORIGINS` | comma-separated list, entries trimmed, empty entries dropped; default `http://localhost:3000` (`src/config/environment.ts:135-138`) | api: Better Auth trusted origins and the CORS allow-list (`src/server.ts:224-230`, `:582`); cli `staff:bootstrap-first-admin` (`src/cli/bootstrap-first-admin.ts:75`) | Never required. Outside production `exp://`, `exp://**` and `exp://192.168.*.*:*/**` are appended (`src/server.ts:224-227`); with `APPLE_OAUTH_ENABLED=true`, `https://appleid.apple.com` is appended (`src/server.ts:228-230`). A blank value gives an empty list. |
| `STAFF_INVITATION_ACCEPT_URL` | URL; blank is unset (`src/config/environment.ts:73-76`) | api (`src/server.ts:749`) and cli `staff:bootstrap-first-admin` (`src/cli/bootstrap-first-admin.ts:91`), both through `resolveStaffInvitationAcceptUrl` (`src/config/environment.ts:658-666`) | Never required. Unset: `<BETTER_AUTH_URL>/staff/accept-invitation`. |
| `GOOGLE_OAUTH_ENABLED` | `true` \| `false`; default `false` (`src/config/environment.ts:139-142`) | api (`src/server.ts:329-338`) | Never required. `true` needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (`src/config/environment.ts:409-418`). The Google provider is configured only when the flag is `true` and both values exist. |
| `GOOGLE_CLIENT_ID` | string, at least 1 character; blank is unset (`src/config/environment.ts:143-146`) | api (`src/server.ts:330`, `:335`) | Required with `GOOGLE_CLIENT_SECRET` as a pair, in both directions (`src/config/environment.ts:445-453`). |
| `GOOGLE_CLIENT_SECRET` | string, at least 1 character; blank is unset (`src/config/environment.ts:147-150`) | api (`src/server.ts:331`, `:336`) | See `GOOGLE_CLIENT_ID`. Secret. |
| `APPLE_OAUTH_ENABLED` | `true` \| `false`; default `false` (`src/config/environment.ts:151-154`) | api (`src/server.ts:228`, `:339`) | Never required. `true` needs `APPLE_CLIENT_ID` (`src/config/environment.ts:437-444`), and the four Apple values are all-or-none, so in effect all four. |
| `APPLE_CLIENT_ID` | string; blank is unset (`src/config/environment.ts:155`) | api (`src/server.ts:340`, `:347`, `:350`) | All four `APPLE_*` values are set together or none is (`src/config/environment.ts:419-436`). |
| `APPLE_TEAM_ID` | string; blank is unset (`src/config/environment.ts:156`) | api (`src/server.ts:341`, `:351`) | See `APPLE_CLIENT_ID`. Not the same value as `PASSKEY_APPLE_TEAM_ID`. |
| `APPLE_KEY_ID` | string; blank is unset (`src/config/environment.ts:157`) | api (`src/server.ts:342`, `:352`) | See `APPLE_CLIENT_ID`. |
| `APPLE_PRIVATE_KEY` | string (PKCS#8 text; the literal two characters `\n` are turned into newlines) (`src/config/environment.ts:158`, `src/modules/auth/infrastructure/customer/apple-client-secret.ts:14`) | api (`src/server.ts:343`, `:353`) | See `APPLE_CLIENT_ID`. Secret. The client secret is built per use with a 180-day lifetime (`src/modules/auth/infrastructure/customer/apple-client-secret.ts:4`, `:13-23`). |

### 2.4 DPoP and device attestation

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `DPOP_PHASE1_CUTOVER_AT` | date (ISO 8601 string); blank is unset (`src/config/environment.ts:25-28`) | api, passed to the Better Auth plugin and to the authentication middleware (`src/server.ts:319-321`, `:610-612`) | Never required. Unset: `phase1CutoverAt` is undefined and every unbound session counts as created before the cutover, so it may bind to the first valid proof it presents (`src/modules/auth/api/shared/require-authentication.ts:229`, `src/modules/auth/application/shared/dpop-proof-verifier.ts:273`, `src/modules/auth/infrastructure/shared/dpop-session-creation.ts:307`). `.env.example:20-28` says to set it once at the phase 1 deploy and never move it. |
| `PLAY_INTEGRITY_POLICY` | `disabled` \| `relaxed` \| `strict`; default `disabled` (`src/config/environment.ts:110`) | api (`src/server.ts:271`) | Never required. With `NODE_ENV=production` and `APP_ENV` not `staging`, only `strict` boots (`src/config/environment.ts:581-592`). `disabled` skips the Play Integrity token check only; Android key attestation is always enforced (`src/config/environment.ts:85-93`). A value other than `disabled` with no decoder (see the next two rows) makes device enrolment fail at run time with `Play Integrity policy requires a decoder, but none is configured` (`src/modules/auth/application/customer/device-enrolment.service.ts:192-196`). |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | string; blank is unset (`src/config/environment.ts:111`) | api: decoder is built only when this and the service account value are both set (`src/server.ts:262-269`) | Never required by the schema. |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | string, base64 of a service account JSON (decode-only role); blank is unset (`src/config/environment.ts:114`) | api (`src/server.ts:263`, `:267`) | See the row above. Secret. |
| `ANDROID_ATTESTATION_CERT_DIGESTS` | comma-separated SHA-256 digests; each entry must normalise (non-hex characters removed) to 64 hex characters; blank is unset (`src/config/environment.ts:119-122`, `:593-610`) | api (`src/server.ts:273`) | Never required by the schema. With an empty list every enrolment is refused with `app signing certificate is not on the allowlist` (`src/modules/auth/application/customer/android-attestation-verifier.ts:287-292`). |
| `ANDROID_ATTESTATION_ROOT_CERTIFICATES` | comma-separated base64 DER certificates; blank is unset (`src/config/environment.ts:131-134`) | api (`src/server.ts:272`) | Never required by the schema. With an empty list every enrolment is refused with `no pinned attestation roots configured` (`src/modules/auth/application/customer/android-attestation-verifier.ts:161-163`); there is no built-in fallback. |

### 2.5 WebAuthn and passkey association

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `WEBAUTHN_RP_NAME` | string, at least 1 character; default `VistaBlox` (`src/config/environment.ts:29`) | api: staff WebAuthn ceremony (`src/server.ts:627`) | Never required. |
| `WEBAUTHN_RP_ID` | bare lowercase hostname (no scheme, port, path or trailing dot); blank is unset (`src/config/environment.ts:35`, `:870-884`) | api, through `resolveWebAuthnSettings` (`src/server.ts:305`, `src/config/environment.ts:699-715`); cli `staff:bootstrap-first-admin`, through the same function (`src/cli/bootstrap-first-admin.ts:76`) | Never required. Unset: the hostname of `BETTER_AUTH_URL`. When set, `BETTER_AUTH_URL`'s hostname must equal it or end with `.<value>` (`src/config/environment.ts:535-552`). Every enrolled passkey is bound to this value (`src/config/environment.ts:30-34`). |
| `WEBAUTHN_ORIGIN` | comma-separated exact origins (`https://host[:port]`, no path, trailing slash, wildcard, IP address or port 0; `localhost` and loopback allowed outside production); no duplicates; blank is unset (`src/config/environment.ts:43-56`, `:826-841`) | api, through `resolveWebAuthnSettings` (`src/server.ts:305`); cli `staff:bootstrap-first-admin`, through the same function (`src/cli/bootstrap-first-admin.ts:76`) | Never required. Unset: the origin of `BETTER_AUTH_URL`. An entry whose host is not the RP ID or a subdomain of it is a related origin, served at `/.well-known/webauthn` (`src/app.ts:558-567`). In production every entry must be `https` on a real host (`src/config/environment.ts:611-628`), and related origins may span at most 5 registrable-domain labels (`src/config/environment.ts:629-646`, `:717`). |
| `PASSKEY_APPLE_TEAM_ID` | string; blank is unset (`src/config/environment.ts:57`) | api (`src/server.ts:586-588`) | Never required. Unset: `/.well-known/apple-app-site-association` is not mounted (`src/app.ts:522-533`). |
| `PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS` | comma-separated list; blank is unset (`src/config/environment.ts:58-61`) | api (`src/server.ts:591-596`) | Never required. Unset: `/.well-known/assetlinks.json` is not mounted (`src/app.ts:534-552`). |
| `PASSKEY_ANDROID_ORIGINS` | comma-separated `android:apk-key-hash:<base64url>` origins, one per signing key; blank is unset (`src/config/environment.ts:69-72`) | api, through `resolveWebAuthnSettings` (`src/config/environment.ts:706-711`); cli `staff:bootstrap-first-admin`, through the same function (`src/cli/bootstrap-first-admin.ts:76`) | Never required. Added to the passkey plugin's accepted origins only, not to the staff ceremony (`src/config/environment.ts:706-713`). |

### 2.6 Email

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `SMTP_HOST` | string, at least 1 character; no default (`src/config/environment.ts:159`) | api (`src/server.ts:214`), worker (`src/worker.ts:82`), cli `staff:bootstrap-first-admin` (`src/cli/bootstrap-first-admin.ts:80`) | Required. The transport is created without connecting (`src/infrastructure/email/smtp-email-sender.ts:88-93`), so a wrong host shows only when a message is sent. The staging anchor fixes it to `maildev` (`docker-compose.staging.yml:242`). |
| `SMTP_PORT` | integer 1-65535; default `587` (`src/config/environment.ts:160`) | api (`src/server.ts:215`), worker (`src/worker.ts:83`), cli (`src/cli/bootstrap-first-admin.ts:81`) | Never required. Both compose files set `1025` (`docker-compose.yml:112`, `:154`, `docker-compose.staging.yml:243`). |
| `SMTP_SECURE` | `true` \| `false`; default `false` (`src/config/environment.ts:161-164`) | api (`src/server.ts:216`), worker (`src/worker.ts:84`), cli (`src/cli/bootstrap-first-admin.ts:82`) | Never required. |
| `SMTP_USER` | string, at least 1 character; no default (`src/config/environment.ts:165`) | api (`src/server.ts:217`), worker (`src/worker.ts:85`), cli (`src/cli/bootstrap-first-admin.ts:83`) | Required. |
| `SMTP_PASSWORD` | string, at least 1 character; no default (`src/config/environment.ts:166`) | api (`src/server.ts:218`), worker (`src/worker.ts:86`), cli (`src/cli/bootstrap-first-admin.ts:84`) | Required. Secret. |
| `SMTP_FROM` | string, at least 1 character; no default (`src/config/environment.ts:167`) | api (`src/server.ts:219`), worker (`src/worker.ts:87`), cli (`src/cli/bootstrap-first-admin.ts:85`) | Required. |

The mail types the sender can send are the 11 methods of `EmailSender` (`src/infrastructure/email/smtp-email-sender.ts:61-73`): staff invitation, applicant response reminder, KYC renewal reminder, reconfirmation reminder, reconfirmation window opened, four account recovery notices (case opened, approved, rejected, completed), passkey recovery and the device replacement code.

### 2.7 Rate limit and cache

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `RATE_LIMIT_CACHE_URL` | `redis://` or `rediss://` URL; blank is unset (`src/config/environment.ts:168-177`) | api (`src/server.ts:142-158`) | Never required. Unset, or a failed first connection (3 s timeout, no reconnect strategy), means no rate limiter: requests pass unmetered (`src/server.ts:142-158`, `:202-205`). A store error after a successful connection also lets the request through (`src/shared/http/rate-limit.ts:54-62`). Tiers are fixed in code: baseline 300 requests and tightened 10 requests per 60 seconds (`src/shared/http/rate-limit.ts:17-27`). The worker does not read it. |
| `PROFILE_CACHE_URL` | `redis://` or `rediss://` URL; blank is unset (`src/config/environment.ts:204-212`) | api (`src/server.ts:165-188`) and worker (`src/worker.ts:121-157`), each with its own client (3 s connect timeout, no reconnect) | Never required. Unset or unreachable: the Didit display-name cache is skipped and a warning is logged (`src/server.ts:175-184`, `src/worker.ts:131-140`). |

### 2.8 Document storage (MinIO)

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `MINIO_ENDPOINT` | string; blank is unset (`src/config/environment.ts:213`) | api (`src/server.ts:499`, `:504`, `:525`, `:532`, `:542-543`) | Never required. Member of the all-or-none group (section 4.3). The staging anchor fixes it to `minio` (`docker-compose.staging.yml:232`). |
| `MINIO_PORT` | integer 1-65535; default `9000` (`src/config/environment.ts:214`) | api (`src/server.ts:505`, `:532`, `:543`) | Never required. |
| `MINIO_USE_SSL` | `true` \| `false`; default `false` (`src/config/environment.ts:215-218`) | api (`src/server.ts:506`, `:532`, `:543`) | Never required. |
| `MINIO_ACCESS_KEY` | string; blank is unset (`src/config/environment.ts:219`) | api (`src/server.ts:500`, `:507`, `:526`, `:535`) | Member of the all-or-none group. The staging compose file also uses it as the MinIO root user (`docker-compose.staging.yml:43`). Secret. |
| `MINIO_SECRET_KEY` | string of at least 8 characters; blank is unset (`src/config/environment.ts:220-223`) | api (`src/server.ts:501`, `:508`, `:527`, `:535`) | Member of the all-or-none group. Used as the MinIO root password in staging (`docker-compose.staging.yml:44`). Secret. |
| `MINIO_QUARANTINE_BUCKET` | string; blank is unset; no default in the schema (`src/config/environment.ts:224`) | validated only; read by the bucket initialiser with default `vistablox-quarantine` (`src/infrastructure/storage/ensure-minio-bucket.ts:13`, `src/infrastructure/storage/storage-buckets.ts:4`) | Never required. |
| `MINIO_PRIVATE_BUCKET` | string; blank is unset; no default in the schema (`src/config/environment.ts:225`) | api: case-document upload and download are built only when this and the three connection values are set (`src/server.ts:524-544`); initialiser default `vistablox-private` (`src/infrastructure/storage/ensure-minio-bucket.ts:14`) | Not in the all-or-none group. With the other four MinIO values set and this one missing, the API boots without case-document upload and download (probe; `src/server.ts:524-544`). |
| `MINIO_KYC_BUCKET` | string; blank is unset; no default in the schema (`src/config/environment.ts:226`) | validated only; initialiser default `vistablox-kyc` (`src/infrastructure/storage/ensure-minio-bucket.ts:15`) | Never required. |
| `MINIO_DISCLOSURES_BUCKET` | bucket name matching `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`; blank is unset; no default in the schema (`src/config/environment.ts:227`) | api: disclosure-document store and the offering repository's bucket name (`src/server.ts:498-523`, `src/modules/offering/repository/offering-repository-options.ts:24`); initialiser default `vistablox-disclosures` (`src/infrastructure/storage/ensure-minio-bucket.ts:16`) | Member of the all-or-none group. Unset: the store is `UnavailableDisclosureDocumentStore` and the staff disclosure-document routes are not mounted (`src/server.ts:511-523`). |
| `MINIO_AUDIT_BUCKET` | string; blank is unset; no default in the schema (`src/config/environment.ts:228`) | validated only; initialiser default `vistablox-audit` (`src/infrastructure/storage/ensure-minio-bucket.ts:17`) | Never required. |

The guide [document-storage.md](document-storage.md) lists the five bucket names with "default" values (`docs/document-storage.md:27-31`). The defaults are applied by the bucket initialiser and by the compose files (`docker-compose.staging.yml:237-241`), not by the API's schema.

### 2.9 Malware scanning (ClamAV)

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `CLAMAV_HOST` | string; blank is unset; no default in the schema (`src/config/environment.ts:229`) | api (`src/server.ts:497`) | Never required. The scanner is always constructed, with `127.0.0.1` when this is unset (`src/server.ts:497`), so an unset value points the API at itself. The scanner is used by case-document and disclosure-document uploads (`src/server.ts:521`, `:538`). The dev compose passes `clamav` (`docker-compose.yml:118`); the staging compose passes it only to `storage-init`, which never reads it (`docker-compose.staging.yml:89`). |
| `CLAMAV_PORT` | integer 1-65535; default `3310` (`src/config/environment.ts:230`) | api (`src/server.ts:497`) | Never required. |

> Pending #236: `CLAMAV_HOST` and `CLAMAV_PORT` move into the `&app-environment` anchor, defaulting to `clamav` and `3310`; `.env.example` is not updated by that pull request.

> Pending #225: the scanner writes a literal backslash and zero after `zINSTREAM` instead of a NUL byte (`src/infrastructure/antivirus/clamav-scanner.ts:16`), so on main a reachable clamd answers an unknown command; the pull request fixes the byte and adds `npm run clamav:smoke`.

### 2.10 Didit (identity verification)

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `DIDIT_API_BASE_URL` | URL; default `https://verification.didit.me` (`src/config/environment.ts:241`) | api (`src/server.ts:386`), worker (`src/worker.ts:99`) | Never required. |
| `DIDIT_API_KEY` | string, at least 1 character; no default (`src/config/environment.ts:242`) | api (`src/server.ts:387`), worker (`src/worker.ts:100`) | Required. Secret. |
| `DIDIT_WORKFLOW_ID` | UUID; no default (`src/config/environment.ts:243`) | api (`src/server.ts:402`, `:419`), worker (`src/worker.ts:162`) | Required. Must differ from `DIDIT_POA_WORKFLOW_ID` (`src/config/environment.ts:454-462`). |
| `DIDIT_CALLBACK_URL` | URL; no default (`src/config/environment.ts:244`) | api (`src/server.ts:403`, `:419`, `:428`) | Required; validated only in the worker. |
| `DIDIT_WEBHOOK_SECRET` | string of at least 16 characters; no default (`src/config/environment.ts:245`) | api: webhook signature verifier (`src/server.ts:442`) | Required; validated only in the worker. Secret. |
| `DIDIT_APPLICATION_ID` | UUID; no default (`src/config/environment.ts:246`) | worker (`src/worker.ts:163`) | Required; validated only in the API. |
| `DIDIT_ENVIRONMENT` | `sandbox` \| `live`; no default (`src/config/environment.ts:247`) | worker (`src/worker.ts:164`) | Required; validated only in the API. |
| `DIDIT_POA_WORKFLOW_ID` | UUID; blank is unset (`src/config/environment.ts:251`) | api (`src/server.ts:424-429`), worker (`src/worker.ts:165-167`) | Never required. Unset: the proof-of-address session service is not built (`src/server.ts:423-429`). |

The Didit values are required outright; there is no mode without them (`src/config/environment.ts:231-240`).

### 2.11 Coinbase onramp

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `COINBASE_CDP_API_BASE_URL` | URL; default `https://api.developer.coinbase.com` (`src/config/environment.ts:252`) | api (`src/server.ts:451`), worker (`src/worker.ts:188`) | Never required. |
| `COINBASE_CDP_PAY_HOSTED_URL` | URL; default `https://pay.coinbase.com/buy/select-asset` (`src/config/environment.ts:253`) | api (`src/server.ts:452`), worker (`src/worker.ts:189`) | Never required. |
| `COINBASE_CDP_API_KEY_ID` | UUID; blank is unset (`src/config/environment.ts:254`) | api (`src/server.ts:446`, `:453`), worker (`src/worker.ts:185`, `:190`) | The three values `COINBASE_CDP_API_KEY_ID`, `COINBASE_CDP_API_KEY_SECRET` and `COINBASE_ONRAMP_REDIRECT_URL` are set together or none is (`src/config/environment.ts:463-479`). Without them there is no Coinbase client: no reservation funding route, no `case_timers.reservation_onramp_poll` queue (section 5). |
| `COINBASE_CDP_API_KEY_SECRET` | string (PEM EC key or base64 Ed25519 key); blank is unset (`src/config/environment.ts:255`) | api (`src/server.ts:447`, `:454`), worker (`src/worker.ts:185`, `:191`) | See the row above. Secret. |
| `COINBASE_ONRAMP_BLOCKCHAIN` | string, at least 1 character; default `base` (`src/config/environment.ts:256`) | api (`src/server.ts:707`) | Never required. |
| `COINBASE_ONRAMP_REDIRECT_URL` | URL; blank is unset (`src/config/environment.ts:257-260`) | api (`src/server.ts:444`, `:448`) | See `COINBASE_CDP_API_KEY_ID`. |
| `COINBASE_ONRAMP_WEBHOOK_SECRET` | string of at least 16 characters; blank is unset (`src/config/environment.ts:263-266`) | api (`src/server.ts:462`, `:465`) | Never required. Needs the three CDP values (`src/config/environment.ts:480-489`). Unset: `POST /webhooks/coinbase-onramp` is not mounted and the minute poll is the only trigger (`src/server.ts:458-467`). Secret. |

`RESERVATION_FUNDING_RAIL_ENABLED`, the human switch for the funding rail, is in section 2.18.

### 2.12 Chain and settlement

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `CHAIN_NETWORK` | `base` \| `base-sepolia`; blank is unset (`src/config/environment.ts:289-292`) | api (`src/server.ts:553`, `:562`, `:670`, `:673`, `:689`), worker (`src/worker.ts:229`, `:234`), cli `settlement:open-ipo-escrow-campaigns` (through `settlementChainConfig`, `src/infrastructure/blockchain/settlement-bundle.ts:42-55`) | `CHAIN_NETWORK`, `CHAIN_RPC_URL` and `CHAIN_OPERATOR_PRIVATE_KEY` are set together or none is (`src/config/environment.ts:490-507`). Both networks are accepted in every environment; nothing ties the network to `NODE_ENV` or `APP_ENV`. The operator command refuses every network except `base-sepolia` (`src/modules/settlement/domain/ipo-escrow-campaign.policy.ts:195-202`). |
| `CHAIN_RPC_URL` | URL; blank is unset (`src/config/environment.ts:293`) | api (`src/server.ts:554`, `:563`, `:689-690`), worker (`src/worker.ts:230`, `:235`) | See `CHAIN_NETWORK`. |
| `CHAIN_OPERATOR_PRIVATE_KEY` | `0x` followed by 64 hex digits; blank is unset (`src/config/environment.ts:294-300`) | worker signs with it (`src/worker.ts:231`, `:236`); the API only tests that it is present, through `isSettlementBundleConfigured` (`src/server.ts:131`, `src/infrastructure/blockchain/settlement-bundle.ts:28`) | See `CHAIN_NETWORK`. Secret; the platform's own wallet, not a customer's. The API reads balances without a key (`src/server.ts:546-568`). |
| `VISTABLOX_PROPERTY_CONTRACT_ADDRESS` | `0x` followed by 40 hex digits; blank is unset (`src/config/environment.ts:305`, `:860-868`) | api: balance reader (`src/server.ts:555`, `:564`); worker (`src/worker.ts:240-242`) | The four addresses (property, IPO escrow, EURC token, PIV treasury) are set together or none is, and only when the chain trio is set (`src/config/environment.ts:508-534`). All eight together form the settlement bundle. |
| `VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS` | `0x` followed by 40 hex digits; blank is unset (`src/config/environment.ts:306`) | worker (`src/worker.ts:243-245`); api only through the bundle test (`src/modules/offering/repository/offering-repository-options.ts:24-27`) | See the row above. |
| `EURC_TOKEN_ADDRESS` | `0x` followed by 40 hex digits; blank is unset (`src/config/environment.ts:307`) | api: balance reader (`src/server.ts:556`, `:565`); worker (`src/worker.ts:246-248`) | See the property address row. |
| `PIV_TREASURY_ADDRESS` | `0x` followed by 40 hex digits; blank is unset (`src/config/environment.ts:313`) | worker (`src/worker.ts:249-251`); api only through the bundle test | See the property address row. A placeholder single destination for escrow sweeps (`src/config/environment.ts:308-313`). |
| `ESCROW_MINT_NONCE_BLOCK_TAG` | `finalized` \| `safe` \| `latest`; blank means the default `finalized` (`src/config/environment.ts:369-372`) | worker, passed to the escrow finalizer (`src/worker.ts:293`) | Never required. Block tag at which the finalizer reads the operator's confirmed nonce when it reconciles an interrupted mint (`src/config/environment.ts:363-368`); see [escrow-mint-reconciliation.md](escrow-mint-reconciliation.md). |

> Pending #240: the API and the worker check the chain id and the contract code at boot, and an unreachable RPC ends the process.

`.env.example` states that `CHAIN_RPC_URL` must accept EIP-1898 block-hash parameters with `requireCanonical` in `eth_call` (`.env.example:208-212`); that is a property of the provider, not a check in the schema.

### 2.13 Wallet registry

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` | `0x` followed by 40 hex digits; blank is unset (`src/config/environment.ts:323`) | api (`src/server.ts:670`, `:675`, `:688-690`), worker (`src/worker.ts:252-256`, `:298`, `:326`, `:377`) | Never required, and independent of the chain trio on purpose (`src/config/environment.ts:314-322`). The API needs it to hand back the registry call target; the watcher needs it and the chain trio. Unset: no registry health check queue and no watcher (section 5). |
| `WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES` | integer 1-1440; default `5` (`src/config/environment.ts:324`) | worker (`src/worker.ts:304`, `:358`, `:379`) | Never required. Blank is refused. |
| `WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES` | integer 2-1440; default `10`; blank is the default (`src/config/environment.ts:331`) | worker (`src/worker.ts:319`) | Never required. Age of the last completed watcher run at which `wallet_registry.watcher_stalled` is raised. |
| `WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS` | integer 1-1,000,000; default `900`; blank is the default (`src/config/environment.ts:334`) | worker (`src/worker.ts:320`) | Never required. |
| `WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT` | integer 1-10,000; default `1`; blank is the default (`src/config/environment.ts:337`) | worker (`src/worker.ts:322`) | Never required. |
| `WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT` | integer 1-10,000; default `5`; blank is the default (`src/config/environment.ts:340`) | worker (`src/worker.ts:323`) | Never required. |
| `WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS` | integer 1-720; default `24`; blank is the default (`src/config/environment.ts:346`) | worker (`src/worker.ts:388`) | Never required. Age at which a pending claim is expired. |
| `WALLET_REGISTRY_PENDING_EXPIRE_SWEEP_MINUTES` | integer 1-60 that divides 60; default `15`; blank is the default (`src/config/environment.ts:350-359`) | worker: cron of `maintenance.wallet_registration_expiry` (`src/worker.ts:586`) | Never required. A value that does not divide 60 is refused. |
| `WALLET_REGISTRY_PENDING_EXPIRE_BATCH_SIZE` | integer 1-5000; default `500`; blank is the default (`src/config/environment.ts:362`) | worker (`src/worker.ts:389`) | Never required. |

Five of these variables (`WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES`, `WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES`, `WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS`, `WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT`, `WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT`) are the only variables in the repository that a test compares across the schema, `.env.example` and the staging anchor, including their defaults (`tests/wallet-registry-alert-config.test.ts:24-30`, `:48-56`). The three expiry variables have the same defaults in all three places (checked by script) but no test. What each alert means and what to do is in [wallet-registration-operations.md](wallet-registration-operations.md).

### 2.14 Dead letters

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `DEAD_LETTER_ALERT_WEBHOOK_URL` | URL; blank is unset; must start with `https://` when `NODE_ENV=production` (`src/config/environment.ts:381`, `:571-580`) | worker (`src/worker.ts:894-896`) | Never required. Unset: no webhook; the error-level log line is written either way. The URL is a credential and is never logged. Delivery, the alert body and ownership are in [dead-letter-jobs.md](dead-letter-jobs.md); the record's entry for the alert scope and the replay command is register C-022. |

> Pending #241: a new variable `DEAD_LETTER_ALERT_WINDOW_MINUTES` throttles alerts per queue, with an "N more" line.

### 2.15 Account and staff recovery

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `ACCOUNT_RECOVERY_REDIRECT_URL` | URL; blank is unset (`src/config/environment.ts:81-84`) | api (`src/server.ts:404-405`) | Never required. Unset: `com.vistablox.app://recover-account`. Named in `.env.example:59` and in no `README.md`, guide or plan that predates this documentation set (searched). |
| `STAFF_RECOVERY_REDIRECT_URL` | URL; blank is unset (`src/config/environment.ts:77-80`) | api (`src/server.ts:736-738`) | Never required. Unset: `<BETTER_AUTH_URL>/staff/recover-account`. |
| `ACCOUNT_RECOVERY_ALERT_AFTER_HOURS` | integer 1-720; default `24` (`src/config/environment.ts:375`) | worker (`src/worker.ts:822`, `:825`) | Never required. Age at which an open customer recovery case is counted as overdue. Blank is refused. |
| `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` | `true` \| `false`; default `false` (`src/config/environment.ts:102-105`) | api (`src/server.ts:406`) | Never required. `true` is accepted only when `APP_ENV=staging` (`src/config/environment.ts:553-561`). |
| `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING` | `true` \| `false`; default `false` (`src/config/environment.ts:106-109`) | api (`src/server.ts:407`) | Never required. `true` is accepted only when `APP_ENV=staging` (`src/config/environment.ts:562-570`). |

> Pending #238: `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` and the single-reviewer behaviour are removed.

Both staging switches are passed by the staging anchor with default `false` (`docker-compose.staging.yml:155-156`). The recovery flow is in [account-recovery.md](account-recovery.md) and [staff-access.md](staff-access.md); the record's entry for the two switches is register C-013.

### 2.16 Device replacement

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `DEVICE_REPLACEMENT_CODE_TTL_MINUTES` | integer 1-60; default `10` (`src/config/environment.ts:386`) | api (`src/server.ts:254`) | Never required. Lifetime of the emailed code. Blank is refused. |
| `DEVICE_REPLACEMENT_MAX_ATTEMPTS` | integer 1-10; default `5` (`src/config/environment.ts:387`) | api (`src/server.ts:255`) | Never required. Verification attempts per code. |
| `DEVICE_REPLACEMENT_COOLDOWN_HOURS` | integer 1-720; default `72` (`src/config/environment.ts:388`) | api (`src/server.ts:256`) | Never required. |
| `DEVICE_REPLACEMENT_RATE_LIMIT_PER_HOUR` | integer 1-60; default `3` (`src/config/environment.ts:389`) | api (`src/server.ts:259`) | Never required. Code requests per account per hour. |

### 2.17 KYC alerts

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `KYC_CREATING_ALERT_AFTER_MINUTES` | integer 1-1440; default `15` (`src/config/environment.ts:373`) | worker (`src/worker.ts:107`, `:811`) | Never required. Age at which a session still being created is stuck. Blank is refused. |
| `KYC_OPEN_ALERT_AFTER_MINUTES` | integer 1-10080; default `60` (`src/config/environment.ts:374`) | worker (`src/worker.ts:113`, `:817`) | Never required. Age at which an open session is re-checked against Didit. Blank is refused. |

### 2.18 Feature flags and cutover dates

| Variable | Type, constraint, default | Read by | Required, and effect when unset |
| --- | --- | --- | --- |
| `RESERVATION_FUNDING_RAIL_ENABLED` | `true` \| `false`; default `false` (`src/config/environment.ts:272-275`) | api (`src/server.ts:474-475`) | Never required. `true` has an effect only together with a configured Coinbase client; the flag is `RESERVATION_FUNDING_RAIL_ENABLED && coinbaseCdpClient !== undefined`. The schema cannot know whether Coinbase supports EUR on Base for this account; a human sets it after the checklist in [investor-offering.md](investor-offering.md). |
| `OPERATING_DISTRIBUTION_ENABLED` | `true` \| `false`; default `false` (`src/config/environment.ts:280-283`) | worker (`src/worker.ts:217-219`) | Never required. `true` creates, schedules and consumes `rental.operating_distribution_sweep` (`src/worker.ts:429-431`, `:536-545`, `:626-630`). |

All switches and the one cutover date, in one place:

| Variable | Kind | Default | Full row |
| --- | --- | --- | --- |
| `RESERVATION_FUNDING_RAIL_ENABLED` | boolean | `false` | section 2.18 |
| `OPERATING_DISTRIBUTION_ENABLED` | boolean | `false` | section 2.18 |
| `GOOGLE_OAUTH_ENABLED` | boolean | `false` | section 2.3 |
| `APPLE_OAUTH_ENABLED` | boolean | `false` | section 2.3 |
| `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` | boolean, staging only | `false` | section 2.15 |
| `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING` | boolean, staging only | `false` | section 2.15 |
| `SMTP_SECURE`, `MINIO_USE_SSL` | boolean, transport | `false` | sections 2.6, 2.8 |
| `PLAY_INTEGRITY_POLICY` | three-valued policy | `disabled` | section 2.4 |
| `DPOP_PHASE1_CUTOVER_AT` | date | unset | section 2.4 |

The mobile-facing feature flags in the app configuration are not variables: `device_auth: true`, `device_enrolment_required: false`, `signing_requests: false`, `recovery_v2: false`, `safe_account: false` and the minimum app versions `0.0.0` are literals in `src/server.ts:660-669`.

### 2.19 Variables outside the schema

These names are read or set by something other than `loadEnvironment()`. The nine names listed in section 1.4 are all in this table; the other names were found by reading the compose files, the Dockerfiles, `tests/` and `contracts/`.

| Name | Read or set by | Purpose and notes |
| --- | --- | --- |
| `DIRECT_DATABASE_URL` | `prisma.config.ts:4-6`; set in `.env.example:285`, by the dev `migrate` service (`docker-compose.yml:92`), by the staging `migrate` service and the staging anchor (`docker-compose.staging.yml:108`, `:135`), and by CI (`.github/workflows/ci.yml:49`) | Connection that every Prisma command uses, including `prisma migrate deploy` in the `migrate` image (`Dockerfile:27-28`, `package.json:24-27`). Falls back to a local URL when unset. The staging anchor also hands it to the API and worker containers, where nothing reads it. |
| `TEST_DATABASE_URL` | the integration test files (for example `tests/kyc-repository.integration.test.ts:10`); `.github/workflows/ci.yml:47`; `.env.example:292` | A local PostgreSQL 18 test database. Unset, each `tests/*.integration.test.ts` file skips itself (`README.md:138-146`). |
| `TEST_MINIO_ENDPOINT`, `TEST_MINIO_ACCESS_KEY`, `TEST_MINIO_SECRET_KEY`, `TEST_MINIO_PORT` | `tests/minio-disclosure-document-store.integration.test.ts:14-18` | The one integration test file that CI allows to skip (`.github/workflows/ci.yml:93`). `TEST_MINIO_PORT` defaults to `9000`. |
| `VITEST_JSON_REPORT` | `.github/workflows/ci.yml:51`, `:76`, `:87` | Path of the vitest JSON report that the skip guard reads. CI only. |
| `GITHUB_STEP_SUMMARY` | `.github/workflows/ci.yml:114-115` | Supplied by GitHub Actions; the skip guard appends its summary to that file when the variable is set. CI only. |
| `EMAIL_VERIFICATION_ENABLED` | `docker-compose.staging.yml:192` | Passed with default `false` to the staging containers; no code reads it (a search of the repository finds no other source reference). |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Postgres image; dev `docker-compose.yml:4-7`, staging `docker-compose.staging.yml:7-9`; `scripts/deploy/staging.sh:13` | Configure the Postgres container. In staging `POSTGRES_PASSWORD` is required (`:?`) and is also embedded in the database URLs of the anchor and of `migrate` (`docker-compose.staging.yml:108`, `:134-135`). |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO image; dev `docker-compose.yml:43-44`; staging `docker-compose.staging.yml:43-44` | The MinIO root account. In staging both come from `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY`, so the application's service credential is the root credential there. |
| `MAILDEV_WEB_PORT`, `MAILDEV_SMTP_PORT`, `MAILDEV_BASE_PATHNAME` | `infrastructure/maildev/Dockerfile:23-24`, `:27` | Ports and path prefix of the maildev image (web UI 1080, SMTP 1025). |
| `DEPLOYER_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL` | `contracts/hardhat.config.js:29-35` | Hardhat deployment settings. The RPC URLs default to the public Base endpoints. Hardhat loads the repository-root `.env` and `contracts/.env` (`contracts/hardhat.config.js:7-8`), so a deployer key written to the root `.env` is also in the file that the dev compose hands to the API and worker (`docker-compose.yml:103-104`, `:148-149`). |
| `EURC_TOKEN_ADDRESS` (second reader), `VISTABLOX_BASE_URI` | `contracts/scripts/deploy.js:6-7`, `:23` | The deploy script uses an existing EURC address when set, and the token metadata URI (default `https://vistablox.io/api/metadata/{id}.json`). |
| `DATABASE_URL`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (second reader) | `src/modules/auth/infrastructure/shared/better-auth.cli.ts:8-15` | A module that no other file imports (searched `src`, `tests`, `package.json`); it carries development fallbacks and is compiled into `dist/` (`tsconfig.build.json:9`). |
| `DATABASE_URL` (third reader) | `tmp/create-dev-intake-fixture.ts:3` | Development fixture script committed under `tmp/`; falls back to a local URL. |

Names that appear only in `docs/plans/devops-device-bound-auth.md:182-203` and are not read anywhere in `src/`: `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`, `APP_ATTEST_ENVIRONMENT`, `CHAIN_RPC_URLS`, `BUNDLER_URL`, `PAYMASTER_URL`, `PUBLIC_BUNDLER_URLS`, `CDP_PAYMASTER_ADDRESS`, `EMAIL_RECOVERY_RELAYER_URL`, `SAFE_*` and `ETH_RESERVE_FUNDER_*` (a search of `src/`, `contracts/scripts` and `package.json` found no match). They are planned names, not configuration.

The CI workflow sets five names for its one job: `TEST_DATABASE_URL`, `DATABASE_URL` and `DIRECT_DATABASE_URL` (all three point at the throwaway PostgreSQL service), `BETTER_AUTH_SECRET` (a dummy value) and `VITEST_JSON_REPORT` (`.github/workflows/ci.yml:46-51`). No test calls `loadEnvironment()` with the process environment (a search of `tests/` finds no such call), which is why the job needs no `DIDIT_*` or `SMTP_*` values (`.github/workflows/ci.yml:42-45`).

### 2.20 Values that look like configuration and are not

| Value | Where it is fixed |
| --- | --- |
| Rate-limit tiers: baseline 300 requests, tightened 10 requests, both per 60 seconds | `src/shared/http/rate-limit.ts:17-27` |
| Didit client timeout 4 s; Coinbase client timeout 8 s | `src/server.ts:388`, `:455`; `src/worker.ts:101`, `:192` |
| Redis connect timeout 3 s and no reconnect strategy, for both caches | `src/server.ts:147`, `:170`; `src/worker.ts:126` |
| ClamAV scan timeout 120 s | `src/infrastructure/antivirus/clamav-scanner.ts:8` |
| Dead-letter webhook timeout 5 s | `src/shared/jobs/dead-letter-alert-webhook.ts:6` |
| JSON body limit 1 MB; Coinbase webhook raw body limit 256 KB | `src/app.ts:588`, `:581` |
| Worker health listener port 3001 on `127.0.0.1` | `src/shared/health/worker-heartbeat.ts:4`, `:61` |
| Retry profiles (event jobs 16 retries from 30 s capped at 900 s; scheduled jobs 5 retries) and the 30-day dead-letter retention | `src/shared/jobs/enqueue-job.ts:21-32`, `src/shared/jobs/job-queues.ts:12-22` |
| Mobile bundle identifiers `com.vistablox.app` for the association files | `src/server.ts:589-590` |
| S3 client region `us-east-1` with path-style addressing | `src/server.ts:533-534` |
| Mobile feature flags and minimum app versions | `src/server.ts:660-669` |

## 3. Where each variable is set

Every one of the 97 schema variables, with the places that can set it. In the columns `.env.example`, `docker-compose.yml` and `docker-compose.staging.yml` a number is a line of that file. For the dev compose, "`.env` only" means that no `environment:` entry names the variable, so the value comes from the `.env` file that the API and the worker load as an `env_file` (`docker-compose.yml:103-104`, `:148-149`). For the staging compose, "`.env.staging` only" means that the anchor does not name the variable, so a value reaches the API and worker containers only if the host's `.env.staging` file contains it (section 6); "anchor" is the `&app-environment` mapping (`docker-compose.staging.yml:133-247`), whose entries are `fixed` (a literal), `default` (`${NAME:-value}`), `blank default` (`${NAME:-}`), `required` (`${NAME:?...}`) or `no default` (`${NAME}`, which becomes a blank string with a warning when the variable is missing).

| Variable | `.env.example` | `docker-compose.yml` | `docker-compose.staging.yml` | Described in |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | :1 | `.env` only | `.env.staging` only | [security.md](security.md) |
| `HOST` | :15 | `.env` only | `.env.staging` only | [architecture.md](architecture.md) |
| `PORT` | :16 | `.env` only | `.env.staging` only | [architecture.md](architecture.md) |
| `LOG_LEVEL` | :17 | `.env` only | anchor :228 (default) | [operations.md](operations.md) |
| `DATABASE_URL` | :280 | api :106; worker :151 | anchor :134 (fixed host, password required) | [data-model.md](data-model.md) |
| `BETTER_AUTH_URL` | :18 | api :109 | `.env.staging` only | [authentication.md](authentication.md) |
| `BETTER_AUTH_SECRET` | :19 | `.env` only | `.env.staging` only | [security.md](security.md) |
| `DPOP_PHASE1_CUTOVER_AT` | :28 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `WEBAUTHN_RP_NAME` | :29 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `WEBAUTHN_RP_ID` | :38 | `.env` only | anchor :140 (default) | [authentication.md](authentication.md) |
| `WEBAUTHN_ORIGIN` | :45 | `.env` only | anchor :146 (blank default) | [authentication.md](authentication.md) |
| `PASSKEY_APPLE_TEAM_ID` | :47 | `.env` only | anchor :175 (blank default) | [authentication.md](authentication.md) |
| `PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS` | :48 | `.env` only | anchor :177 (blank default) | [authentication.md](authentication.md) |
| `PASSKEY_ANDROID_ORIGINS` | :53 | `.env` only | anchor :176 (blank default) | [authentication.md](authentication.md) |
| `STAFF_INVITATION_ACCEPT_URL` | :55 | `.env` only | anchor :149 (blank default) | [staff-access.md](staff-access.md) |
| `STAFF_RECOVERY_REDIRECT_URL` | :57 | `.env` only | anchor :150 (blank default) | [staff-access.md](staff-access.md) |
| `ACCOUNT_RECOVERY_REDIRECT_URL` | :59 | `.env` only | `.env.staging` only | this page |
| `APP_ENV` | :10 | `.env` only | anchor :154 (fixed) | [security.md](security.md) |
| `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` | :12 | `.env` only | anchor :155 (default) | [staff-access.md](staff-access.md) |
| `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING` | :14 | `.env` only | anchor :156 (default) | [staff-access.md](staff-access.md) |
| `PLAY_INTEGRITY_POLICY` | :71 | `.env` only | anchor :170 (default) | [authentication.md](authentication.md) |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | :72 | `.env` only | anchor :171 (blank default) | [authentication.md](authentication.md) |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | :75 | `.env` only | anchor :172 (blank default) | [authentication.md](authentication.md) |
| `ANDROID_ATTESTATION_CERT_DIGESTS` | :81 | `.env` only | anchor :173 (blank default) | [authentication.md](authentication.md) |
| `ANDROID_ATTESTATION_ROOT_CERTIFICATES` | :88 | `.env` only | anchor :174 (blank default) | [authentication.md](authentication.md) |
| `AUTH_TRUSTED_ORIGINS` | :63 | api :110 | `.env.staging` only | [authentication.md](authentication.md) |
| `GOOGLE_OAUTH_ENABLED` | :92 | `.env` only | anchor :178 (default) | [authentication.md](authentication.md) |
| `GOOGLE_CLIENT_ID` | :93 | `.env` only | anchor :179 (blank default) | [authentication.md](authentication.md) |
| `GOOGLE_CLIENT_SECRET` | :94 | `.env` only | anchor :180 (blank default) | [authentication.md](authentication.md) |
| `APPLE_OAUTH_ENABLED` | :96 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `APPLE_CLIENT_ID` | :98 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `APPLE_TEAM_ID` | :99 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `APPLE_KEY_ID` | :100 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `APPLE_PRIVATE_KEY` | :102 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `SMTP_HOST` | :104 | api :111; worker :153 | anchor :242 (fixed) | [operations.md](operations.md) |
| `SMTP_PORT` | :105 | api :112; worker :154 | anchor :243 (fixed) | [operations.md](operations.md) |
| `SMTP_SECURE` | :106 | api :113; worker :155 | anchor :244 (fixed) | [operations.md](operations.md) |
| `SMTP_USER` | :107 | api :114; worker :156 | anchor :245 (fixed) | [operations.md](operations.md) |
| `SMTP_PASSWORD` | :108 | api :115; worker :157 | anchor :246 (fixed) | [operations.md](operations.md) |
| `SMTP_FROM` | :109 | api :116; worker :158 | anchor :247 (fixed) | [operations.md](operations.md) |
| `RATE_LIMIT_CACHE_URL` | :121 | api :107 | `.env.staging` only | [security.md](security.md) |
| `TRUST_PROXY` | :142 | `.env` only | anchor :166 (blank default) | [security.md](security.md) |
| `PROFILE_CACHE_URL` | :116 | api :108; worker :152 | `.env.staging` only | [investor-profile.md](investor-profile.md) |
| `MINIO_ENDPOINT` | :145 | storage-init :73, api via :117 (anchor) | storage-init :79 (fixed); anchor :232 (fixed) | [document-storage.md](document-storage.md) |
| `MINIO_PORT` | :146 | storage-init :74, api via :117 (anchor) | storage-init :80 (fixed); anchor :233 (fixed) | [document-storage.md](document-storage.md) |
| `MINIO_USE_SSL` | :147 | storage-init :75, api via :117 (anchor) | storage-init :81 (fixed); anchor :234 (fixed) | [document-storage.md](document-storage.md) |
| `MINIO_ACCESS_KEY` | :148 | storage-init :76, api via :117 (anchor) | storage-init :82 (required); anchor :235 (required) | [document-storage.md](document-storage.md) |
| `MINIO_SECRET_KEY` | :149 | storage-init :77, api via :117 (anchor) | storage-init :83 (required); anchor :236 (required) | [document-storage.md](document-storage.md) |
| `MINIO_QUARANTINE_BUCKET` | :150 | storage-init :78, api via :117 (anchor) | storage-init :84 (default); anchor :237 (default) | [document-storage.md](document-storage.md) |
| `MINIO_PRIVATE_BUCKET` | :151 | storage-init :79, api via :117 (anchor) | storage-init :85 (default); anchor :238 (default) | [document-storage.md](document-storage.md) |
| `MINIO_KYC_BUCKET` | :152 | storage-init :80, api via :117 (anchor) | storage-init :86 (default); anchor :239 (default) | [document-storage.md](document-storage.md) |
| `MINIO_DISCLOSURES_BUCKET` | :153 | storage-init :81, api via :117 (anchor) | storage-init :87 (default); anchor :240 (default) | [document-storage.md](document-storage.md) |
| `MINIO_AUDIT_BUCKET` | :154 | storage-init :82, api via :117 (anchor) | storage-init :88 (default); anchor :241 (default) | [document-storage.md](document-storage.md) |
| `CLAMAV_HOST` | no | api :118 | storage-init :89 (fixed) | [security.md](security.md) |
| `CLAMAV_PORT` | no | api :119 | storage-init :90 (fixed) | [security.md](security.md) |
| `DIDIT_API_BASE_URL` | :160 | `.env` only | `.env.staging` only | [didit-kyc.md](didit-kyc.md) |
| `DIDIT_API_KEY` | :161 | `.env` only | anchor :184 (no default, blank if unset) | [didit-kyc.md](didit-kyc.md) |
| `DIDIT_WORKFLOW_ID` | :162 | `.env` only | anchor :186 (no default, blank if unset) | [didit-kyc.md](didit-kyc.md) |
| `DIDIT_CALLBACK_URL` | :163 | `.env` only | anchor :185 (no default, blank if unset) | [didit-kyc.md](didit-kyc.md) |
| `DIDIT_WEBHOOK_SECRET` | :170 | `.env` only | anchor :188 (no default, blank if unset) | [didit-kyc.md](didit-kyc.md) |
| `DIDIT_APPLICATION_ID` | :168 | `.env` only | anchor :189 (no default, blank if unset) | [didit-kyc.md](didit-kyc.md) |
| `DIDIT_ENVIRONMENT` | :169 | `.env` only | anchor :190 (no default, blank if unset) | [didit-kyc.md](didit-kyc.md) |
| `DIDIT_POA_WORKFLOW_ID` | :166 | `.env` only | anchor :187 (blank default) | [didit-kyc.md](didit-kyc.md) |
| `COINBASE_CDP_API_BASE_URL` | :176 | `.env` only | `.env.staging` only | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| `COINBASE_CDP_PAY_HOSTED_URL` | :177 | `.env` only | `.env.staging` only | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| `COINBASE_CDP_API_KEY_ID` | :178 | `.env` only | `.env.staging` only | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| `COINBASE_CDP_API_KEY_SECRET` | :179 | `.env` only | `.env.staging` only | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| `COINBASE_ONRAMP_BLOCKCHAIN` | :180 | `.env` only | `.env.staging` only | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| `COINBASE_ONRAMP_REDIRECT_URL` | :183 | `.env` only | `.env.staging` only | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| `COINBASE_ONRAMP_WEBHOOK_SECRET` | :190 | `.env` only | `.env.staging` only | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| `RESERVATION_FUNDING_RAIL_ENABLED` | :196 | `.env` only | anchor :191 (default) | [investor-offering.md](investor-offering.md) |
| `OPERATING_DISTRIBUTION_ENABLED` | :200 | `.env` only | `.env.staging` only | [jobs-and-workers.md](jobs-and-workers.md) |
| `CHAIN_NETWORK` | :213 | `.env` only | anchor :203 (blank default) | [jobs-and-workers.md](jobs-and-workers.md) |
| `CHAIN_RPC_URL` | :214 | `.env` only | anchor :204 (blank default) | [jobs-and-workers.md](jobs-and-workers.md) |
| `CHAIN_OPERATOR_PRIVATE_KEY` | :215 | `.env` only | anchor :205 (blank default) | [jobs-and-workers.md](jobs-and-workers.md) |
| `VISTABLOX_PROPERTY_CONTRACT_ADDRESS` | :216 | `.env` only | anchor :206 (blank default) | [api/wallet.md](api/wallet.md) |
| `VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS` | :217 | `.env` only | anchor :207 (blank default) | [investor-offering.md](investor-offering.md) |
| `EURC_TOKEN_ADDRESS` | :218 | `.env` only | anchor :208 (blank default) | [api/wallet.md](api/wallet.md) |
| `PIV_TREASURY_ADDRESS` | :221 | `.env` only | anchor :209 (blank default) | [investor-offering.md](investor-offering.md) |
| `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` | :229 | `.env` only | anchor :212 (blank default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES` | :230 | `.env` only | anchor :216 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES` | :238 | `.env` only | anchor :217 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS` | :239 | `.env` only | anchor :218 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT` | :240 | `.env` only | anchor :219 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT` | :241 | `.env` only | anchor :220 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS` | :246 | `.env` only | anchor :221 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_PENDING_EXPIRE_SWEEP_MINUTES` | :252 | `.env` only | anchor :222 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `WALLET_REGISTRY_PENDING_EXPIRE_BATCH_SIZE` | :253 | `.env` only | anchor :223 (default) | [wallet-registration-operations.md](wallet-registration-operations.md) |
| `ESCROW_MINT_NONCE_BLOCK_TAG` | :257 | `.env` only | anchor :227 (default) | [escrow-mint-reconciliation.md](escrow-mint-reconciliation.md) |
| `KYC_CREATING_ALERT_AFTER_MINUTES` | :258 | `.env` only | `.env.staging` only | [jobs-and-workers.md](jobs-and-workers.md) |
| `KYC_OPEN_ALERT_AFTER_MINUTES` | :259 | `.env` only | `.env.staging` only | [jobs-and-workers.md](jobs-and-workers.md) |
| `ACCOUNT_RECOVERY_ALERT_AFTER_HOURS` | :260 | `.env` only | `.env.staging` only | [jobs-and-workers.md](jobs-and-workers.md) |
| `DEAD_LETTER_ALERT_WEBHOOK_URL` | :265 | `.env` only | anchor :225 (blank default) | [dead-letter-jobs.md](dead-letter-jobs.md) |
| `DEVICE_REPLACEMENT_CODE_TTL_MINUTES` | :269 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `DEVICE_REPLACEMENT_MAX_ATTEMPTS` | :270 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `DEVICE_REPLACEMENT_COOLDOWN_HOURS` | :271 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |
| `DEVICE_REPLACEMENT_RATE_LIMIT_PER_HOUR` | :272 | `.env` only | `.env.staging` only | [authentication.md](authentication.md) |

The matrix shows what the files do, not what a deployment holds. The host's `.env.staging` is not in the repository, and the repository has no production configuration.

## 4. Boot-time rules

Everything in this section is checked by `loadEnvironment()` before the process does anything else, so a violation ends the process with exit code 1 (section 1.2). The API, the worker and every command apply all of it.

### 4.1 Cross-field rules

The schema ends with 18 `.refine(...)` rules. The message column is the text in the error, shortened where the code message is longer.

| # | What makes the process refuse to start | Message | Code | Test |
| --- | --- | --- | --- | --- |
| 1 | Some, but not all, of `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_DISCLOSURES_BUCKET` are set | `All MinIO document storage settings must be configured together` | `src/config/environment.ts:391-408` | `tests/minio-environment.test.ts` |
| 2 | `GOOGLE_OAUTH_ENABLED=true` without both Google credentials | `Google OAuth credentials are required when GOOGLE_OAUTH_ENABLED=true` | `src/config/environment.ts:409-418` | `tests/oauth-environment.test.ts:27` |
| 3 | Some, but not all, of `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` are set | `All Apple OAuth settings must be configured together` | `src/config/environment.ts:419-436` | `tests/oauth-environment.test.ts:32` |
| 4 | `APPLE_OAUTH_ENABLED=true` without `APPLE_CLIENT_ID` | `Apple OAuth credentials are required when APPLE_OAUTH_ENABLED=true` | `src/config/environment.ts:437-444` | none found by message text |
| 5 | Exactly one of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` is set | `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together` | `src/config/environment.ts:445-453` | none found by message text |
| 6 | `DIDIT_POA_WORKFLOW_ID` equals `DIDIT_WORKFLOW_ID` | `DIDIT_POA_WORKFLOW_ID must differ from DIDIT_WORKFLOW_ID` | `src/config/environment.ts:454-462` | `tests/didit-environment.test.ts` |
| 7 | Some, but not all, of `COINBASE_CDP_API_KEY_ID`, `COINBASE_CDP_API_KEY_SECRET`, `COINBASE_ONRAMP_REDIRECT_URL` are set | `All Coinbase CDP onramp settings must be configured together` | `src/config/environment.ts:463-479` | none found by message text |
| 8 | `COINBASE_ONRAMP_WEBHOOK_SECRET` without `COINBASE_CDP_API_KEY_ID` | `COINBASE_ONRAMP_WEBHOOK_SECRET requires the Coinbase CDP onramp settings, ...` | `src/config/environment.ts:480-489` | `tests/coinbase-onramp-environment.test.ts:42` |
| 9 | Some, but not all, of `CHAIN_NETWORK`, `CHAIN_RPC_URL`, `CHAIN_OPERATOR_PRIVATE_KEY` are set | `CHAIN_NETWORK, CHAIN_RPC_URL, and CHAIN_OPERATOR_PRIVATE_KEY must be configured together` | `src/config/environment.ts:490-507` | `tests/chain-settlement-environment.test.ts` |
| 10 | Some, but not all, of the four contract and treasury addresses are set, or all four are set while `CHAIN_NETWORK` is unset | `VISTABLOX_PROPERTY_CONTRACT_ADDRESS, ... must be configured together, and only alongside CHAIN_NETWORK/CHAIN_RPC_URL/CHAIN_OPERATOR_PRIVATE_KEY` | `src/config/environment.ts:508-534` | `tests/chain-settlement-environment.test.ts` |
| 11 | `WEBAUTHN_RP_ID` is set and the hostname of `BETTER_AUTH_URL` neither equals it nor ends with `.<value>` | `BETTER_AUTH_URL's hostname must equal WEBAUTHN_RP_ID or be a subdomain of it` | `src/config/environment.ts:535-552` | `tests/webauthn-environment.test.ts` |
| 12 | `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE=true` and `APP_ENV` is not `staging` | `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE=true is permitted only when APP_ENV=staging` | `src/config/environment.ts:553-561` | `tests/play-integrity-environment.test.ts` |
| 13 | `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING=true` and `APP_ENV` is not `staging` | `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING=true is permitted only when APP_ENV=staging` | `src/config/environment.ts:562-570` | `tests/play-integrity-environment.test.ts` |
| 14 | `NODE_ENV=production` and `DEAD_LETTER_ALERT_WEBHOOK_URL` does not start with `https://` | `DEAD_LETTER_ALERT_WEBHOOK_URL must be an https:// URL when NODE_ENV=production` | `src/config/environment.ts:571-580` | `tests/dead-letter-operations.test.ts` |
| 15 | `NODE_ENV=production`, `APP_ENV` is not `staging` and `PLAY_INTEGRITY_POLICY` is not `strict` | `PLAY_INTEGRITY_POLICY must be "strict" in production -- "disabled" and "relaxed" exist for staging only` | `src/config/environment.ts:581-592` | `tests/play-integrity-environment.test.ts` |
| 16 | An `ANDROID_ATTESTATION_CERT_DIGESTS` entry that does not normalise to 64 hex characters | `ANDROID_ATTESTATION_CERT_DIGESTS: each entry must be a 64-character SHA-256 hex digest (colons and case are ignored)` | `src/config/environment.ts:593-610` | `tests/play-integrity-environment.test.ts` |
| 17 | `NODE_ENV=production` and a `WEBAUTHN_ORIGIN` entry that is not `https` or is `localhost` or loopback | `WEBAUTHN_ORIGIN: every entry must be https in production, on a real host -- ...` | `src/config/environment.ts:611-628` | `tests/webauthn-environment.test.ts` |
| 18 | The related origins (those whose host is not the RP ID or a subdomain of it) span more than 5 registrable-domain labels | `WEBAUTHN_ORIGIN: related origins span more than 5 distinct registrable-domain labels -- ...` | `src/config/environment.ts:629-646`, `:717` | `tests/webauthn-environment.test.ts` |

"None found by message text" means that a search of `tests/` for the rule's message and variable names found no test for it; it does not mean that the rule does not work. A probe of a copy of `src/config/environment.ts` triggered each of the 18 rules and produced the messages above; for rule 18, an origin on the RP ID's own domain plus five related origins on five other domains boots, and six related origins are refused. Rules 14 and 17 key on `NODE_ENV`, not `APP_ENV`: staging, which runs `NODE_ENV=production`, gets no relaxation from them (`src/config/environment.ts:571-580`, `:611-628`; the comment at `:622-623` says so for rule 17).

> Pending #238: rule 12 and the variable it checks are removed.

> Pending #240: a boot-time check of the chain id and the contract code is added to the API and the worker; an unreachable RPC ends the process at boot, which no rule above can do.

### 4.2 Field-level rules

Rules that sit on one variable and fail with Zod's own message.

| Variable | Rule | Code |
| --- | --- | --- |
| `DATABASE_URL` | URL whose text starts with `postgresql://` | `src/config/environment.ts:14-16` |
| `RATE_LIMIT_CACHE_URL`, `PROFILE_CACHE_URL` | URL starting with `redis://` or `rediss://` | `src/config/environment.ts:168-177`, `:204-212` |
| `DIDIT_WORKFLOW_ID`, `DIDIT_APPLICATION_ID`, `DIDIT_POA_WORKFLOW_ID`, `COINBASE_CDP_API_KEY_ID` | UUID | `src/config/environment.ts:243`, `:246`, `:251`, `:254` |
| `BETTER_AUTH_SECRET`, `MINIO_SECRET_KEY`, `DIDIT_WEBHOOK_SECRET`, `COINBASE_ONRAMP_WEBHOOK_SECRET` | at least 32, 8, 16 and 16 characters | `src/config/environment.ts:18`, `:220-223`, `:245`, `:263-266` |
| `CHAIN_OPERATOR_PRIVATE_KEY` | `0x` and 64 hex digits | `src/config/environment.ts:294-300` |
| the four contract and treasury addresses and `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` | `0x` and 40 hex digits (any letter case) | `src/config/environment.ts:860-868` |
| `WEBAUTHN_RP_ID` | bare lowercase DNS hostname | `src/config/environment.ts:870-884` |
| `WEBAUTHN_ORIGIN` | each entry an exact origin, no duplicates | `src/config/environment.ts:43-56`, `:826-841` |
| `TRUST_PROXY` | a hop count 0-10 or a list that `express().set("trust proxy", ...)` also accepts; `true` and wide ranges refused | `src/config/environment.ts:756-796` |
| `MINIO_DISCLOSURES_BUCKET` | `^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$` | `src/config/environment.ts:227` |
| `WALLET_REGISTRY_PENDING_EXPIRE_SWEEP_MINUTES` | integer 1-60 that divides 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60) | `src/config/environment.ts:350-359` |
| every numeric variable | integer within the range given in section 2; a non-integer or out-of-range value is refused | section 2 |

### 4.3 All-or-none groups

| Group | Members | Rule | Not in the group |
| --- | --- | --- | --- |
| MinIO | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_DISCLOSURES_BUCKET` | all set or none (rule 1) | `MINIO_PRIVATE_BUCKET`, `MINIO_QUARANTINE_BUCKET`, `MINIO_KYC_BUCKET`, `MINIO_AUDIT_BUCKET`, `MINIO_PORT`, `MINIO_USE_SSL`; a missing `MINIO_PRIVATE_BUCKET` leaves case documents unmounted without an error (section 8, L6) |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | both or neither (rule 5); both required when `GOOGLE_OAUTH_ENABLED=true` (rule 2) | the flag itself: credentials without the flag leave Google off (`src/server.ts:329-338`) |
| Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | all four or none (rule 3); `APPLE_OAUTH_ENABLED=true` needs `APPLE_CLIENT_ID` (rule 4) | the flag itself |
| Coinbase onramp | `COINBASE_CDP_API_KEY_ID`, `COINBASE_CDP_API_KEY_SECRET`, `COINBASE_ONRAMP_REDIRECT_URL` | all three or none (rule 7); `COINBASE_ONRAMP_WEBHOOK_SECRET` needs the key id (rule 8) | `RESERVATION_FUNDING_RAIL_ENABLED`, `COINBASE_ONRAMP_BLOCKCHAIN` |
| Chain connectivity | `CHAIN_NETWORK`, `CHAIN_RPC_URL`, `CHAIN_OPERATOR_PRIVATE_KEY` | all three or none (rule 9) | `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` |
| Settlement bundle | `VISTABLOX_PROPERTY_CONTRACT_ADDRESS`, `VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS`, `EURC_TOKEN_ADDRESS`, `PIV_TREASURY_ADDRESS` | all four or none, and only with `CHAIN_NETWORK` (rule 10). With the chain trio this is the seven-variable settlement bundle that `isSettlementBundleConfigured` tests (`src/infrastructure/blockchain/settlement-bundle.ts:24-34`) | `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS`, which is optional on its own (`src/config/environment.ts:314-323`) |

The chain trio on its own is a valid configuration (probe: it boots without the four addresses). Two features depend on the bundle without the schema saying so: the API gates reservations on escrow readiness through the same seven-variable test (`src/server.ts:127-132`), and the worker's escrow queues exist only when it holds (section 5). The API and the worker therefore must be given the same `CHAIN_*` values; the staging anchor passes the same set to both (`docker-compose.staging.yml:203-209`).

## 5. Which variables switch which feature

What exists at run time depends on which variables are set, and the schema does not report a feature as absent. The table names the condition, the process, and the effect of its absence. "api" and "worker" refer to `src/server.ts` and `src/worker.ts`; the callers and consumers are in [jobs-and-workers.md](jobs-and-workers.md) and the API chapters.

| Feature | Condition | Process | When the condition fails | Code |
| --- | --- | --- | --- | --- |
| IP and account rate limiting | `RATE_LIMIT_CACHE_URL` set and the first connection succeeds | api | no limiter; requests are not metered | `src/server.ts:142-158`, `:202-205` |
| Didit display-name cache | `PROFILE_CACHE_URL` set and connected | api, worker | display names omitted, invalidation skipped, warning logged | `src/server.ts:165-188`, `src/worker.ts:121-157` |
| Google sign-in | `GOOGLE_OAUTH_ENABLED=true` and both credentials | api | provider not configured | `src/server.ts:329-338` |
| Apple sign-in | `APPLE_OAUTH_ENABLED=true` and the four Apple values | api | provider not configured; `https://appleid.apple.com` not trusted | `src/server.ts:228-230`, `:339-356` |
| Play Integrity decoder | `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` and `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | api | no decoder; any policy other than `disabled` makes enrolment fail | `src/server.ts:262-269`, `src/modules/auth/application/customer/device-enrolment.service.ts:192-196` |
| Apple association file | `PASSKEY_APPLE_TEAM_ID` | api | `/.well-known/apple-app-site-association` not mounted | `src/app.ts:522-533` |
| Android association file | `PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS` | api | `/.well-known/assetlinks.json` not mounted | `src/app.ts:534-552` |
| Related-origin file | a `WEBAUTHN_ORIGIN` entry outside the RP ID's host | api | `/.well-known/webauthn` not mounted | `src/app.ts:558-567` |
| Proof-of-address KYC session | `DIDIT_POA_WORKFLOW_ID` | api | service not built | `src/server.ts:423-429` |
| Case-document upload and download | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_PRIVATE_BUCKET` | api | the two services are `undefined` and not passed on; the staff upload route is mounted only when the upload service exists | `src/server.ts:524-544`, `:616-617`; `src/modules/intake/api/intake-operations.router.ts:226` |
| Disclosure documents (staff) | the same three plus `MINIO_DISCLOSURES_BUCKET` | api | `UnavailableDisclosureDocumentStore`; staff document routes not mounted | `src/server.ts:498-523`, `:622`; `src/modules/offering/api/offering-operations.router.ts:106` |
| Coinbase client | `COINBASE_CDP_API_KEY_ID`, `COINBASE_CDP_API_KEY_SECRET` (and `COINBASE_ONRAMP_REDIRECT_URL` in the api) | api, worker | no client | `src/server.ts:445-457`, `src/worker.ts:184-194` |
| Reservation funding route | Coinbase client and redirect URL | api | `reservations` dependency absent | `src/server.ts:701-711` |
| Funding rail open | `RESERVATION_FUNDING_RAIL_ENABLED=true` and a Coinbase client | api | rail closed | `src/server.ts:474-475` |
| `POST /webhooks/coinbase-onramp` | Coinbase client and `COINBASE_ONRAMP_WEBHOOK_SECRET` | api | route not mounted (404); the minute poll remains | `src/server.ts:461-467`, `src/app.ts:576-587` |
| `case_timers.reservation_onramp_poll` | Coinbase client | worker | queue not created, scheduled or consumed | `src/worker.ts:202-205`, `:426-428`, `:498-503`, `:621-625` |
| `provider_events.coinbase_onramp_webhook` consumer | Coinbase client (the queue itself is always created) | worker | jobs wait unconsumed | `src/worker.ts:206-209`, `:464`, `:860-884` |
| `rental.operating_distribution_sweep` | `OPERATING_DISTRIBUTION_ENABLED=true` | worker | queue not created, scheduled or consumed | `src/worker.ts:217-219`, `:429-431`, `:536-545`, `:626-630` |
| Escrow campaign opening and finalization | the seven-variable settlement bundle | worker | `settlement.open_ipo_escrow_campaign` and `settlement.finalize_ipo_escrow_campaigns` not created; opening an offering enqueues no campaign job | `src/worker.ts:263-294`, `:432-437`, `:504-513`, `:631-635`, `:710-733` |
| Reservations wait for escrow readiness | the same seven variables, evaluated in the api | api | no escrow gate on reservations | `src/server.ts:127-132`, `src/modules/offering/repository/offering-repository-options.ts:24-27` |
| Wallet registry watcher | registry address, chain trio | worker | `settlement.confirm_wallet_registrations` not created | `src/worker.ts:295-305`, `:438-440`, `:514-525`, `:664-674` |
| Wallet registry health check | registry address | worker | `settlement.check_wallet_registry_health` not created | `src/worker.ts:325-361`, `:443-445`, `:526-535`, `:675-679` |
| Wallet balances | `CHAIN_NETWORK`, `CHAIN_RPC_URL`, property address, EURC address | api | balances not served | `src/server.ts:552-568`, `:692` |
| Wallet registration reconciler | `CHAIN_NETWORK`, `CHAIN_RPC_URL`, registry address | api | reconciler not built | `src/server.ts:689-691` |
| Deployment identity in the app config | `CHAIN_NETWORK`, registry address | api | field omitted | `src/server.ts:670-677` |
| Dead-letter alert webhook | `DEAD_LETTER_ALERT_WEBHOOK_URL` | worker | log line only | `src/worker.ts:891-897` |

A queue that has been created and scheduled stays in pg-boss after its condition stops holding: no `unschedule`, `deleteQueue` or `deleteSchedule` call exists in `src/` (searched). A schedule for `rental.operating_distribution_sweep` or the wallet registry jobs therefore keeps sending jobs to a queue with no consumer after the variables are removed. The effect of those jobs was not observed (section 8, L21).

> Pending #237: `createApp` is split into per-module compose functions under `src/composition`; the conditions above stay, and the `src/app.ts` lines move (the pull request does not change `src/server.ts`).

## 6. How a variable reaches the staging containers

`AGENTS.md:21` says that a new variable reaches the containers only if the `&app-environment` anchor of `docker-compose.staging.yml` passes it, and comments in the compose file and in `.env.example` say the same (`docker-compose.staging.yml:213-215`, `.env.example:187-189`). The compose files do something different, and the rule below is what they do. It was checked by resolving `docker-compose.staging.yml` with `docker compose config` against a fake `.env.staging` (no container was started; the file held made-up values).

### 6.1 The rule

1. Compose reads the file given by `--env-file` and uses it to fill every `${NAME}`, `${NAME:-default}` and `${NAME:?message}` in the compose file. `scripts/deploy/staging.sh` and the runbooks pass `--env-file .env.staging` (`scripts/deploy/staging.sh:18-19`, `docs/dead-letter-jobs.md:83-84`, `:94`).
2. Five services also declare `env_file: .env.staging`: `vistablox-db-server`, `storage-init`, `migrate`, `vistablox-api` and `worker` (`docker-compose.staging.yml:4-5`, `:76-77`, `:105-106`, `:131-132`, `:275-276`). Every `KEY=value` line of the file becomes an environment variable of those containers, whether or not the compose file mentions the name.
3. A name that is also listed under a service's `environment:` takes the value from there. For the API this mapping is the anchor `&app-environment` (`docker-compose.staging.yml:133-247`); the worker receives the same mapping through `<<: *app-environment` (`docker-compose.staging.yml:277-278`).
4. The anchor therefore pins or defaults values (`APP_ENV`, `SMTP_*`, `MINIO_*`, the database URLs); it is not a gate that other names must pass through. Of the 97 schema variables, 34 are not in the anchor and reach the API and worker only through the host's file: `NODE_ENV`, `HOST`, `PORT`, `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `DPOP_PHASE1_CUTOVER_AT`, `WEBAUTHN_RP_NAME`, `ACCOUNT_RECOVERY_REDIRECT_URL`, `AUTH_TRUSTED_ORIGINS`, the five `APPLE_*` values, `RATE_LIMIT_CACHE_URL`, `PROFILE_CACHE_URL`, `CLAMAV_HOST`, `CLAMAV_PORT`, `DIDIT_API_BASE_URL`, the seven `COINBASE_*` values other than the flag, `OPERATING_DISTRIBUTION_ENABLED`, `KYC_CREATING_ALERT_AFTER_MINUTES`, `KYC_OPEN_ALERT_AFTER_MINUTES`, `ACCOUNT_RECOVERY_ALERT_AFTER_HOURS` and the four `DEVICE_REPLACEMENT_*` values (section 3, column `docker-compose.staging.yml`). No tracked `.env.staging` template exists; `git ls-files` lists `.env.example` and `secrets/README.md` only, although the compose file mentions a "shared `.env.staging` template" (`docker-compose.staging.yml:229-231`).
5. `maildev`, `minio` and `clamav` have no `env_file`. `minio` receives `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` from `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY` by interpolation (`docker-compose.staging.yml:43-44`).

> Pending #236: `CLAMAV_HOST` and `CLAMAV_PORT` enter the anchor, which leaves 32 of the 97 variables outside it.

What the repository's rule gets right: a variable the anchor names with `${NAME:-default}` gets that default when the file lacks it, and the anchor is the only place where a value is forced.

### 6.2 What the resolved configuration showed

A fake `.env.staging` set the names below; `docker compose --env-file .env.staging -f docker-compose.staging.yml config --format json` was run on a copy of the compose file in a scratch directory.

| Line in the fake `.env.staging` | `vistablox-api` and `worker` received | Why |
| --- | --- | --- |
| `NODE_ENV=development` | `development` | not in the anchor; the file overrides the image's `ENV NODE_ENV=production` (`Dockerfile:33`, `:44`) |
| `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` | the file's values | not in the anchor |
| `CLAMAV_HOST=clamav` | `clamav` | not in the anchor; the file is the only source |
| `KYC_OPEN_ALERT_AFTER_MINUTES=999` | `999` | not in the anchor |
| `RATE_LIMIT_CACHE_URL=redis://...` | the file's value | not in the anchor |
| `POSTGRES_PASSWORD=...` | present as a variable | `env_file` passes it; the anchor uses it only inside URL strings |
| `APP_ENV=production` | `staging` | the anchor's literal wins (`docker-compose.staging.yml:154`) |
| `SMTP_HOST=smtp.real.example` | `maildev` | the anchor's literal wins (`docker-compose.staging.yml:242`) |
| `DATABASE_URL=postgresql://other@elsewhere/db` | the compose Postgres URL | the anchor's entry wins (`docker-compose.staging.yml:134`) |
| `PLAY_INTEGRITY_POLICY=relaxed` | `relaxed` | the anchor's `${PLAY_INTEGRITY_POLICY:-disabled}` is filled from the same file by `--env-file` (`docker-compose.staging.yml:170`) |

The services without an anchor (`vistablox-db-server`, `migrate`, `storage-init`) received every line of the file, including `APP_ENV=production` and the application secrets, and `vistablox-db-server` is the Postgres container.

### 6.3 Consequences for whoever runs compose

- **Pass `--env-file .env.staging` on every compose command.** Without it, compose stops at the first `${...:?...}` (`POSTGRES_PASSWORD`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`). If those three are exported in the shell instead, the anchor's `${DIDIT_API_KEY}` is filled with an empty string and wins over the file's real value (resolved with `docker compose -f docker-compose.staging.yml config` and the three variables exported: `DIDIT_API_KEY` came out empty and `PLAY_INTEGRITY_POLICY` came out `disabled`, although the file held values).
- **A missing `DIDIT_*` value does not fail the deploy script.** The six `DIDIT_*` anchor entries have no default and no `:?` (`docker-compose.staging.yml:184-190`); with the values absent, `docker compose config -q` printed a warning for each and exited 0, so `scripts/deploy/staging.sh:18` passes, and the API and worker then fail the schema at start (section 1.2). A missing `POSTGRES_PASSWORD`, `MINIO_ACCESS_KEY` or `MINIO_SECRET_KEY` fails at once (exit 1).
- **Blank lines are not defaults.** A line `PORT=` in `.env.staging` reaches the API as an empty string and the schema refuses it (section 1.3); the anchor's `${NAME:-default}` form protects only the names it lists.
- **To list the names a container receives, without printing values:**

      docker compose --env-file .env.staging -f docker-compose.staging.yml config --format json \
        | python3 -c "import json,sys; print('\n'.join(sorted(json.load(sys.stdin)['services']['worker']['environment'])))"

  The command was run against the fake file above; it prints names only. `docker compose config` without `--format json` and `-q` prints the values, secrets included.

### 6.4 Against the design record

`SECRETS_IN_DEPLOYMENT.md` (design-record repository, `04-Engineering/PLATFORM-OPERATIONS/SECRETS_IN_DEPLOYMENT.md:22`) and AD-133 and AD-136 describe a single restricted-permission `.env` file per host that Compose reads at container start. The repository's `.env.staging` is that file, kept at mode `0600` (`secrets/README.md:3-5`); the repository states no check of the mode (`scripts/deploy/staging.sh:8-16` tests that the file is readable and has a `POSTGRES_PASSWORD` line, not its permissions). The same document says the direct database connection string is scoped to the migration step and not exposed to the runtime environment (`04-Engineering/PLATFORM-OPERATIONS/SECRETS_IN_DEPLOYMENT.md:29`); the staging anchor hands `DIRECT_DATABASE_URL` to the API and worker containers, where it holds the same credential as `DATABASE_URL` (`docker-compose.staging.yml:134-135`). `secrets/README.md:11-13` says that no SOPS binary or second secret source is involved, and `.sops.yaml:1-3` still declares a creation rule for `secrets/staging.env`. None of these differences is recorded in `00-Governance/MIGRATION/CONFLICT_REGISTER.md`.

## 7. NODE_ENV and APP_ENV

Two variables describe the deployment, and they do different jobs. `NODE_ENV` is the build mode and is read in a handful of places; `APP_ENV` is the tier (staging or production) and is read only by the cross-field rules. The staging containers run with `NODE_ENV=production` so that cookies and trusted origins behave as in production, and `APP_ENV=staging` marks the tier (`docker-compose.staging.yml:151-154`).

| Effect | `NODE_ENV=production` | Otherwise | Code |
| --- | --- | --- | --- |
| Better Auth `useSecureCookies` and the cookie `secure` attribute | on | off | `src/server.ts:313`, `:374`; `src/cli/bootstrap-first-admin.ts:74`; `src/modules/auth/infrastructure/shared/better-auth.factory.ts:457`, `:479` |
| Trusted origins | exactly `AUTH_TRUSTED_ORIGINS` | the list plus `exp://`, `exp://**`, `exp://192.168.*.*:*/**` | `src/server.ts:224-227` |
| `TRUST_PROXY` start-up warning | logged when rate limiting is on and the variable is unset | not logged | `src/server.ts:208-212` |
| `deploymentIdentity.environment` in the app configuration | `production` (staging reports `production` as well) | the other value | `src/server.ts:670-677` |
| `DEAD_LETTER_ALERT_WEBHOOK_URL` must be `https://` | enforced | not enforced | `src/config/environment.ts:571-580` |
| `PLAY_INTEGRITY_POLICY` must be `strict` | enforced unless `APP_ENV=staging` | not enforced | `src/config/environment.ts:581-592` |
| `WEBAUTHN_ORIGIN` entries must be `https` on a real host | enforced | loopback and `http://localhost` allowed | `src/config/environment.ts:611-628` |

Where `NODE_ENV` comes from. The default in the schema is `development` (`src/config/environment.ts:8`). The `api` and `worker` image stages set `production` (`Dockerfile:33`, `:44`); the `migrate` stage and the other images set nothing. The staging compose file does not set it, so a `NODE_ENV` line in `.env.staging` replaces the image's value (section 6.2). `.env.example` starts with `NODE_ENV=development` (`.env.example:1`), and it is the only template. A staging stack that received `NODE_ENV=development` would run with secure cookies off, the `exp://` wildcard origins trusted, loopback WebAuthn origins accepted and an `http://` dead-letter URL accepted. Nothing in the repository checks the value on a deployed host.

Where `APP_ENV` comes from. Unset or blank means production. Only `staging` and `production` are valid; any other spelling is refused. The staging anchor sets `staging` as a literal, so `.env.staging` cannot change it for the API and worker (`docker-compose.staging.yml:154`). The relaxations fail closed: the table is the result of loading a copy of the schema with the twelve required variables set (probes, not a running server).

| `NODE_ENV` | `APP_ENV` | Setting under test | Result |
| --- | --- | --- | --- |
| unset | unset | `PLAY_INTEGRITY_POLICY` left at its default `disabled` | boots |
| `production` | unset | `PLAY_INTEGRITY_POLICY=disabled` | refused (rule 15) |
| `production` | `production` | `PLAY_INTEGRITY_POLICY=disabled` | refused (rule 15) |
| `production` | `Staging` | none | refused (not an allowed value) |
| `production` | `staging` | `PLAY_INTEGRITY_POLICY=disabled` | boots |
| unset | unset | `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE=true` | refused (rule 12) |
| unset | `staging` | `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE=true` | boots |
| `production`, policy `strict` | unset | `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING=true` | refused (rule 13) |
| unset | blank | `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING=true` | refused (rule 13) |

The first row is the one case where nothing is closed: with `NODE_ENV` unset the rules keyed on production are skipped, so the fail-closed property belongs to `APP_ENV` alone. The services also default their own flags to `false` (`src/modules/auth/application/staff/account-recovery.service.ts:131`, `:158`).

## 8. Known limitations

Each row is a defect or a gap in what is built at 48aa967, in neutral wording. Nothing here is fixed by this documentation. "Register" means `00-Governance/MIGRATION/CONFLICT_REGISTER.md` in the design-record repository.

| # | Limitation | Evidence | Issue, pull request or record entry |
| --- | --- | --- | --- |
| L1 | The rule that the anchor is the only route into the staging containers is not what the compose files do; the API and the worker also load every line of `.env.staging`, and so do the database, migrate and storage-init services. | section 6; `AGENTS.md:21`; `docker-compose.staging.yml:131-132`, `:275-276` | none; not in the register; related issues #208 (`CLAMAV_*`) and #173 (`COINBASE_*` in the anchor) |
| L2 | 34 of the 97 variables have no anchor entry, so their staging value is whatever the untracked `.env.staging` holds; no tracked template documents it. | section 3 (script count); `git ls-files` lists no `.env.staging` file; `docker-compose.staging.yml:229-231` | none |
| L3 | `CLAMAV_HOST` and `CLAMAV_PORT` are set only on the one-shot `storage-init` service, which never reads them; the API falls back to `127.0.0.1` when `CLAMAV_HOST` is unset; neither variable is in `.env.example`. | `docker-compose.staging.yml:89-90`; `src/infrastructure/storage/ensure-minio-bucket.ts:9-18`; `src/server.ts:497`; `.env.example` | #208; register C-014, item 7 |
| L4 | `NODE_ENV` is not pinned in the staging compose file and defaults to `development` in the schema, so production-only rules depend on the host file or the image's value. | `docker-compose.staging.yml:131-247`; `src/config/environment.ts:8`; `.env.example:1`; section 7 | none |
| L5 | The maildev web UI is published on every host interface (`1080:1080`) and staging mail includes staff invitation links, recovery links and device replacement codes; the MinIO console is bound to `127.0.0.1`. Whether a host firewall closes 1080 is not verified; a plan describes a LAN-only firewall rule as "later". | `docker-compose.staging.yml:24-29`, `:45-46`; `docs/plans/devops-device-bound-auth.md:27`, `:105-107` | none |
| L6 | `MINIO_PRIVATE_BUCKET` is outside the MinIO all-or-none group, and the schema applies no bucket default; with the other four values set and this one missing, the API boots without case-document upload and download. `docs/document-storage.md:27-31` lists defaults the schema does not apply. | `src/config/environment.ts:224-228`, `:391-408`; `src/server.ts:524-544`; probe | none |
| L7 | Placeholder values from `.env.example` pass validation with `NODE_ENV=production` and `APP_ENV=staging`: the 42-character `BETTER_AUTH_SECRET` placeholder, `SMTP_USER` and `SMTP_PASSWORD` placeholders and `smtp.example.com`. A code comment records that production SMTP is still the placeholder, and the backend plan lists a real sender as a Phase 3 blocker. | `.env.example:19`, `:104-108`; `src/modules/auth/infrastructure/shared/better-auth.factory.ts:228`; `docs/plans/device-bound-auth-backend.md:57`, `:537` | none |
| L8 | The API process needs `CHAIN_OPERATOR_PRIVATE_KEY` in its environment because the escrow-readiness gate tests that the key is present, although the API never signs; the staging anchor passes the key to both services. | `src/server.ts:127-132`, `:546-551`; `src/infrastructure/blockchain/settlement-bundle.ts:24-34`; `docker-compose.staging.yml:205` | Register C-008, item 4 (the pre-gate form); AD-240, AD-286 |
| L9 | `CHAIN_NETWORK` accepts `base` (mainnet) in any environment and `base-sepolia` in production; no rule ties it to `NODE_ENV` or `APP_ENV`. Only the operator command refuses a network other than `base-sepolia`. | `src/config/environment.ts:289-292`, `:490-534`; `src/modules/settlement/domain/ipo-escrow-campaign.policy.ts:195-202`; probes | Register C-008, item 2; AD-234 |
| L10 | No automated check ties the schema, `.env.example` and the two compose files together. One test compares five variables across the schema, `.env.example` and the anchor; CI never runs `docker compose config`; the deploy script does, only at deploy time. | `tests/wallet-registry-alert-config.test.ts:24-30`, `:48-56`; `.github/workflows/ci.yml`; `scripts/deploy/staging.sh:18` | none |
| L11 | Variables are passed and never read: `EMAIL_VERIFICATION_ENABLED` in the anchor; `DIRECT_DATABASE_URL` to the API and worker (read only by `prisma.config.ts`); `CLAMAV_*` to `storage-init`. | `docker-compose.staging.yml:89-90`, `:135`, `:192`; `prisma.config.ts:4-6` | none; `04-Engineering/PLATFORM-OPERATIONS/SECRETS_IN_DEPLOYMENT.md:29` states the scoping the compose file does not follow |
| L12 | Secrets are spread wider than their use: the worker must be given `BETTER_AUTH_SECRET`, `DIDIT_CALLBACK_URL` and `DIDIT_WEBHOOK_SECRET`, the API `DIDIT_APPLICATION_ID` and `DIDIT_ENVIRONMENT`, and every command needs the whole required set. | section 1.1 | none |
| L13 | Blank values are handled differently from variable to variable. Of the 39 variables that have a schema default, 7 wallet registry values and `ESCROW_MINT_NONCE_BLOCK_TAG` take the default on a blank, a blank `AUTH_TRUSTED_ORIGINS` becomes an empty list, and the other 30 refuse a blank. | section 1.3 (script over all 97) | none |
| L14 | Defaults differ across sources: `AUTH_TRUSTED_ORIGINS` is `http://localhost:3000` in the schema, `http://localhost:3000,com.vistablox.app://` in `.env.example`, and forced to `http://localhost:3000` for the dev API container while the dev worker keeps the `.env` value; `WEBAUTHN_RP_ID` has no schema default and `api.vistablox.io` in the anchor; `SMTP_PORT` is 587 in the schema and 1025 in both compose files. The other 37 schema defaults are identical wherever they appear (`CLAMAV_PORT` is absent from `.env.example`). | `src/config/environment.ts:135-138`; `.env.example:63`; `docker-compose.yml:110`; `docker-compose.staging.yml:140`; script | none |
| L15 | Development credentials are committed: the dev Postgres, MinIO and SMTP credentials, with Postgres (5432), the cache (6379) and Mailpit (8025) published on all interfaces; `prisma.config.ts` and `tmp/create-dev-intake-fixture.ts` fall back to a local URL with credentials; an unused file carries a development secret and is compiled into `dist/`; staging forces the SMTP credentials for maildev to fixed literals. | `docker-compose.yml:5-9`, `:23-24`, `:35-36`, `:43-44`, `:76-77`, `:114-115`; `docker-compose.staging.yml:245-246`; `prisma.config.ts:4-6`; `tmp/create-dev-intake-fixture.ts:3`; `src/modules/auth/infrastructure/shared/better-auth.cli.ts:8-14` | none |
| L16 | Stale or wrong statements in the repository: `README.md:126` says to fill in `BETTER_AUTH_SECRET` "at minimum", while a stack started from `.env.example` is also refused until the six `DIDIT_*` values are set; `docs/document-storage.md:27-31` (defaults); `docs/plans/devops-device-bound-auth.md:191` says staging `PLAY_INTEGRITY_POLICY` is `relaxed` while the anchor default is `disabled` (`docker-compose.staging.yml:170`) and the backend plan says `disabled` (`docs/plans/device-bound-auth-backend.md:174`); `docs/plans/devops-device-bound-auth.md:186` lists `SMTP_*` as API-only, the worker reads them (`src/worker.ts:81-88`); `.env.example:5-7` names one staging relaxation, `:11-14` shows two more; `.env.example:46-53` calls `PASSKEY_*` required in production while the schema comment says customer passkeys ended at the Phase 4 cutover (`src/config/environment.ts:681-685`; whether the native association files are still needed is not verified); the comment at `src/config/environment.ts:19-24` says DPoP is "off entirely when unset", while `src/server.ts:315-322` passes the DPoP options unconditionally (section 2.4); the comment at `docker-compose.staging.yml:100-103` says Compose defaults to `restart: unless-stopped`, while the resolved configuration shows no restart value for services without the key; `CLAMAV_HOST`, `CLAMAV_PORT`, `EMAIL_VERIFICATION_ENABLED`, `ACCOUNT_RECOVERY_REDIRECT_URL`, `DEPLOYER_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`, `BASE_MAINNET_RPC_URL` and `VISTABLOX_BASE_URI` are named in no README, `AGENTS.md`, plan or guide that predates this documentation set (searched; sections 2 and 2.19 now describe them). | the cited lines | none |
| L17 | Names differ from the design record: `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` against `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; `CDP_API_KEY` against `COINBASE_CDP_API_KEY_ID` and `COINBASE_CDP_API_KEY_SECRET`; `REDIS_URL` against two variables, `RATE_LIMIT_CACHE_URL` and `PROFILE_CACHE_URL`; `BASE_RPC_URL` and a chain chosen by `NODE_ENV` against `CHAIN_RPC_URL` and `CHAIN_NETWORK`; nginx with Certbot against Traefik in staging. On the record's `main`, `04-Engineering/ARCHITECTURE/DEPLOYMENT_TOPOLOGY.md:94` already names the webhook secret `COINBASE_ONRAMP_WEBHOOK_SECRET` (AD-289, register C-015). The environment inventory of `DEPLOYMENT_TOPOLOGY.md` does not list `APP_ENV`, `TRUST_PROXY`, `PLAY_INTEGRITY_POLICY`, `DEAD_LETTER_ALERT_WEBHOOK_URL` or `CLAMAV_*`; other record files name `DEAD_LETTER_ALERT_WEBHOOK_URL` (`ALERTING.md`, `ASYNC_JOBS.md`), the register names `APP_ENV` (C-013) and `CLAMAV_HOST` (C-014), and no record file names `PLAY_INTEGRITY_POLICY` or `CLAMAV_PORT` (searched on the record's `main`). | `04-Engineering/ARCHITECTURE/DEPLOYMENT_TOPOLOGY.md:25`, `:75-103`, `:94`; `04-Engineering/BLOCKCHAIN/VIEM_CLIENT_SETUP.md:35-36`; `docker-compose.staging.yml:124-130` | AD-133, AD-136, AD-142, AD-289; register C-013, C-014 and C-015 for the names they cover; no entry for the other names |
| L18 | The record gives the API a pooled database connection and the worker a persistent one; the code has one `DATABASE_URL` for both and no variable for a second connection. The production deployment is not in the repository, so how the split is applied is not verified. | `04-Engineering/ARCHITECTURE/DEPLOYMENT_TOPOLOGY.md:34-35`; `src/server.ts:101-102`; `src/worker.ts:74`, `:89` | none |
| L19 | The queue cadence statements in `README.md` differ from the worker: line 41 groups the wallet registry watcher under "every 5 minutes" (it runs every minute), and line 93 says the stuck-session reconciliation is registered only when Didit is configured (it is registered unconditionally). | `README.md:41`, `:93`; `src/worker.ts:454`, `:521`, `:576` | none; see [jobs-and-workers.md](jobs-and-workers.md) |
| L20 | The schema comment of `DPOP_PHASE1_CUTOVER_AT` and the app comment "Undefined leaves DPoP fully off" describe a mode the server never runs in. | `src/config/environment.ts:19-24`; `src/app.ts:298-302`; `src/server.ts:315-322`, `:606-613` | none |
| L21 | A queue and its cron entry stay in pg-boss after the variable that created them is removed; no code removes them. The effect on the stored jobs was not observed. | `src/worker.ts:427-445`, `:499-545`; a search of `src/` for `unschedule`, `deleteQueue` and `deleteSchedule` finds nothing | none |
| L22 | The API's `/health/ready` and the worker's `/health/ready` do not check Redis, MinIO, ClamAV, SMTP or the chain, so a wrong value for those variables does not show in the staging health checks. | `src/modules/health/health.router.ts:18-31`; `src/shared/health/worker-heartbeat.ts:95-97` | none; see [operations.md](operations.md) |

> Pending #236: moves `CLAMAV_HOST` and `CLAMAV_PORT` into the anchor; `.env.example` and the `127.0.0.1` fallback stay as they are.

## 9. Not verified

- **The host's `.env.staging`.** It is not in the repository. Which of the 34 variables that the anchor does not name are set in staging, and with which values (`NODE_ENV`, `AUTH_TRUSTED_ORIGINS`, `RATE_LIMIT_CACHE_URL`, `CLAMAV_HOST`, the `COINBASE_*` values), is unknown.
- **Any production configuration.** The repository holds only the local and staging compose files. How `APP_ENV` stays unset in production, how the pooled and direct database connections are set, and which TLS and proxy arrangement applies there are not in it.
- **Host and network behaviour.** Whether a firewall closes port 1080 or 3000 on the staging host; whether Docker applies the restart policies as read; whether Traefik exists with the `proxy` network and a `cloudflare` certificate resolver.
- **Run-time behaviour of the compose stack.** No container was started. `docker compose config` was used to resolve the files; it needs no daemon. The probes of the schema ran a copy of `src/config/environment.ts` under `tsx` with the dependency versions of the repository (`zod` 4.5.4, `express` 5.2.1), not the built application.
- **PostgreSQL 18.** Nothing in this chapter depends on a PostgreSQL version.
- **Real providers.** Didit, Coinbase, ClamAV 1.4.6, SMTP servers and RPC providers were not contacted. Statements about what a service does with a value (for example how clamd answers a malformed command) rest on the pull requests named in the callouts.
- **The effect of orphaned schedules** (L21) and **the reachability of `PASSKEY_*` association files for native clients** (L16).

## 10. Related documents

| Topic | Document |
| --- | --- |
| Images, compose stacks, deploy flow, health checks, runbooks | [operations.md](operations.md) |
| The worker's queues, boot sequence and the variables it reads | [jobs-and-workers.md](jobs-and-workers.md) |
| Authentication variables: Better Auth, DPoP, attestation, WebAuthn, device replacement | [authentication.md](authentication.md) |
| Staff access, invitations, recovery and the staging relaxations | [staff-access.md](staff-access.md), [account-recovery.md](account-recovery.md) |
| Security controls: proxy trust, rate limiting, scanning, secrets | [security.md](security.md) |
| Operator commands and which environment each needs | [cli.md](cli.md) |
| Document storage and buckets | [document-storage.md](document-storage.md) |
| Didit | [didit-kyc.md](didit-kyc.md) |
| Coinbase onramp | [coinbase-cdp-onramp.md](coinbase-cdp-onramp.md) |
| Funding rail and escrow campaigns | [investor-offering.md](investor-offering.md), [escrow-mint-reconciliation.md](escrow-mint-reconciliation.md) |
| Wallet registry thresholds and alerts | [wallet-registration-operations.md](wallet-registration-operations.md), [investor-profile.md](investor-profile.md) |
| Dead-letter alerts | [dead-letter-jobs.md](dead-letter-jobs.md) |
| Tests that read configuration | [testing.md](testing.md) |
| Data model and migrations | [data-model.md](data-model.md) |
| Index of all documents | [README.md](README.md) |
