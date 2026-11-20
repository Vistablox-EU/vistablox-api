# Status of the documentation and of the code it describes

Valid for main at 48aa967 (2026-11-18).

This page is the one place that collects what the other chapters say is unfinished: the open pull requests whose merge will change a documented statement, the known limitations of the code, the gaps between the code and the design record, the decisions the chapters leave to the founder, and everything that could not be verified. It is read by the founder, by whoever reviews or merges a pull request, and by anyone who updates the documentation after a merge. The chapters stay the source: this page links to them and repeats only a summary line per item.

Contents: [1 Reading this page](#1-reading-this-page) · [2 Built and switched off](#2-built-and-switched-off) · [3 Open pull requests](#3-open-pull-requests-that-change-documented-behaviour) · [4 Known limitations](#4-known-limitations) · [5 Gaps against the design record](#5-gaps-between-the-code-and-the-design-record) · [6 Decisions awaiting the founder](#6-decisions-awaiting-the-founder) · [7 Not verified](#7-what-has-not-been-verified) · [8 Updating this page](#8-how-to-update-this-page-after-a-merge)

## 1. Reading this page

Every chapter describes main at commit `48aa967`. No open pull request is described as present. Where an open pull request changes a statement, the chapter carries one line directly under that statement in the form `> Pending #N: one sentence.` Section 3 lists those pull requests and the chapters that carry their lines. Citations in the chapters have the form `(path:line)` and name the function or identifier, because line numbers drift.

The tables in section 4 are generated from the "Known limitations" section of each chapter, one row per item, with the item's first sentence. A defect that touches two chapters appears in both; the "Same as" column gives the `L-` number of the master list in [security.md](security.md#19-known-limitations) where there is one. The page does not repeat evidence: follow the item link to the chapter.

## 2. Built and switched off

Several parts of the code exist and are inert. A reader who looks for a route or a job and does not find it running should check this table first.

| Capability | State on main | What turns it on | Source |
| --- | --- | --- | --- |
| Signing requests (`/v1/auth/signing-requests`, off-chain types only) | Routes, service, policy and table exist; the routes are never mounted. | `features.signing_requests` is the literal `false` in the app config, and the mount is conditional on it being `true`; no environment variable changes it. | `src/server.ts:665`, `src/app.ts:795-797`; [authentication.md](authentication.md#known-gaps-against-the-design-record), [modules/auth.md](modules/auth.md) |
| Reservation funding rail | Closed by default. | `RESERVATION_FUNDING_RAIL_ENABLED=true`, after a human pre-launch check per environment (issue #7). | `src/config/environment.ts:272-275`; [modules/offering.md](modules/offering.md#11-known-limitations), [investor-offering.md](investor-offering.md) |
| Operating distributions (rental) | Calculation and monthly sweep exist; no code writes a rent collection, and the three deductions are fixed at `0.00`. | `OPERATING_DISTRIBUTION_ENABLED=true`, default `false`. | `src/config/environment.ts:280-283`, `src/worker.ts:215-217`; [modules/rental.md](modules/rental.md) |
| On-chain settlement (campaign opening, finalizer, wallet registry watcher) | Built. Dormant by absent configuration, not by a switch. | The settlement bundle of seven variables for the campaign and finalizer jobs; the registry address and the three base `CHAIN_*` variables for the watcher. | `src/worker.ts:263-306`; [modules/settlement.md](modules/settlement.md) |
| Document upload (staff and customer) | Mounted when the MinIO variables are set, but every upload needs ClamAV and the scanner on main cannot talk to a real clamd. | Open pull request #225 (section 3). | `src/infrastructure/antivirus/clamav-scanner.ts:16`; [security.md](security.md#19-known-limitations) item L-1 |

## 3. Open pull requests that change documented behaviour

None of these is merged. The documentation describes main at `48aa967` only. "Chapters with a Pending line" is built by searching the chapters for `> Pending #N:`; the number in brackets is the count of such lines in that file. A chapter that cites `src/app.ts` line numbers is affected by #237 even where it carries no line of its own.

| PR | State | What it changes | Issue named by the chapters | Chapters with a Pending line |
| --- | --- | --- | --- | --- |
| #203 | open | Design-record paths in `AGENTS.md`, `README.md`, `docs/document-storage.md` and `docs/investor-offering.md` point at the flattened record. | none named | [README.md](README.md), [architecture.md](architecture.md), [integrations.md](integrations.md) |
| #225 | draft | The ClamAV scanner sends a NUL byte after `zINSTREAM` where main sends a backslash and a zero; adds `npm run clamav:smoke`. | #205 | [api/README.md](api/README.md), [api/offering.md](api/offering.md), [architecture.md](architecture.md), [cli.md](cli.md), [configuration.md](configuration.md), [integrations.md](integrations.md), [modules/intake.md](modules/intake.md), [modules/offering.md](modules/offering.md), [operations.md](operations.md), [security.md](security.md), [testing.md](testing.md) (2) |
| #229 | open | Duplicates #225 (the same scanner change); adds an integration test that skips unless `CLAMAV_TEST_HOST` is set. | #205 | [testing.md](testing.md) (2) |
| #233 | open | A dead-letter replay writes an audit row; `--operator` becomes mandatory together with `--confirm`. | #209 | [cli.md](cli.md) (2), [data-model.md](data-model.md), [jobs-and-workers.md](jobs-and-workers.md) (3), [operations.md](operations.md), [security.md](security.md) |
| #234 | open | Device revoke cancels only the caller's own signing requests. | #213 | [authentication.md](authentication.md), [data-model.md](data-model.md) (2), [modules/auth.md](modules/auth.md), [security.md](security.md) |
| #235 | open | The escrow finalizer job fails, and so retries and dead-letters, when a campaign errors. | #206 | [integrations.md](integrations.md), [jobs-and-workers.md](jobs-and-workers.md) (2), [modules/settlement.md](modules/settlement.md), [operations.md](operations.md) |
| #236 | open | `CLAMAV_HOST` and `CLAMAV_PORT` (defaults `clamav` and `3310`) move into the staging `&app-environment` anchor. | #208 | [api/README.md](api/README.md), [api/intake-staff.md](api/intake-staff.md), [api/offering.md](api/offering.md), [architecture.md](architecture.md), [configuration.md](configuration.md) (3), [integrations.md](integrations.md), [modules/intake.md](modules/intake.md), [modules/offering.md](modules/offering.md), [operations.md](operations.md), [security.md](security.md), [testing.md](testing.md) |
| #237 | open | `createApp` is split into per-module compose functions under `src/composition`; no behaviour changes, `src/app.ts` shrinks and its cited line numbers move. | #181 | [api/README.md](api/README.md), [api/auth-customer.md](api/auth-customer.md), [api/auth-staff.md](api/auth-staff.md), [api/intake-customer.md](api/intake-customer.md), [api/intake-staff.md](api/intake-staff.md), [api/offering.md](api/offering.md), [api/platform.md](api/platform.md), [api/wallet.md](api/wallet.md), [architecture.md](architecture.md), [authentication.md](authentication.md), [configuration.md](configuration.md), [integrations.md](integrations.md), [modules/account.md](modules/account.md), [modules/auth.md](modules/auth.md), [modules/identity.md](modules/identity.md), [modules/intake.md](modules/intake.md), [modules/investor-activity.md](modules/investor-activity.md), [modules/offering.md](modules/offering.md), [modules/profile.md](modules/profile.md), [modules/wallet.md](modules/wallet.md), [staff-access.md](staff-access.md), [testing.md](testing.md) (2) |
| #238 | open | `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` and the staging single-reviewer behaviour are removed. | #214 | [api/README.md](api/README.md), [api/auth-staff.md](api/auth-staff.md), [authentication.md](authentication.md) (2), [configuration.md](configuration.md) (2), [data-model.md](data-model.md) (2), [modules/auth.md](modules/auth.md) (2), [operations.md](operations.md), [security.md](security.md), [staff-access.md](staff-access.md) |
| #239 | open | A wallet balance read failure answers `503 wallet.chain_unavailable` where main answers 500. | #155 | [api/README.md](api/README.md), [api/wallet.md](api/wallet.md) (2), [architecture.md](architecture.md), [integrations.md](integrations.md), [modules/wallet.md](modules/wallet.md) |
| #240 | open | At start the api and the worker check the chain id and the contract code; an unreachable RPC ends the process. | #152 | [api/wallet.md](api/wallet.md), [architecture.md](architecture.md) (4), [configuration.md](configuration.md) (2), [integrations.md](integrations.md), [jobs-and-workers.md](jobs-and-workers.md) (3), [modules/settlement.md](modules/settlement.md), [modules/wallet.md](modules/wallet.md), [operations.md](operations.md) |
| #241 | open | Dead-letter alerts are throttled per queue; new variable `DEAD_LETTER_ALERT_WINDOW_MINUTES`; the alert gains an "N more" line. | #210 | [configuration.md](configuration.md), [integrations.md](integrations.md), [jobs-and-workers.md](jobs-and-workers.md) (4), [operations.md](operations.md), [security.md](security.md) |
| #243 | open | A stored malformed media URL is dropped from the offering list, detail and featured responses; main answers 422 for the whole response. | #211 | [api/offering.md](api/offering.md) (4), [architecture.md](architecture.md), [data-model.md](data-model.md) (2), [modules/offering.md](modules/offering.md), [security.md](security.md) |
| #244 | open | New route `POST /v1/offerings/:offering_id/reservations/:reservation_id/payment-session`; a Coinbase 4xx after the hold exists becomes `502 offering.coinbase_provider_request_rejected`; a response that fails its schema becomes `500 internal.response_invalid`; every 5xx carries a fixed detail; idempotency keys are scoped to the account and the path ids. | none named | [api/README.md](api/README.md) (5), [api/auth-staff.md](api/auth-staff.md), [api/intake-customer.md](api/intake-customer.md), [api/intake-staff.md](api/intake-staff.md), [api/offering.md](api/offering.md) (5), [api/platform.md](api/platform.md), [api/wallet.md](api/wallet.md), [architecture.md](architecture.md) (2), [authentication.md](authentication.md), [data-model.md](data-model.md) (2), [integrations.md](integrations.md) (3), [modules/health.md](modules/health.md), [modules/identity.md](modules/identity.md), [modules/investor-activity.md](modules/investor-activity.md), [modules/offering.md](modules/offering.md) (2), [modules/profile.md](modules/profile.md), [modules/wallet.md](modules/wallet.md), [security.md](security.md) (3) |
| #245 | open | Stacked on #244: the same response handling for every remaining router. | none named | [api/auth-customer.md](api/auth-customer.md), [api/auth-staff.md](api/auth-staff.md), [api/intake-customer.md](api/intake-customer.md), [api/intake-staff.md](api/intake-staff.md), [api/wallet.md](api/wallet.md), [architecture.md](architecture.md), [authentication.md](authentication.md), [modules/account.md](modules/account.md), [modules/intake.md](modules/intake.md), [security.md](security.md) |

Notes on the table:

- #229 duplicates #225. Merging one makes the other obsolete; both lines appear in the chapters that describe the scanner.
- #245 is stacked on #244 and applies the same response handling to the remaining routers; the table shows which chapters carry which of the two.
- The pull request lines were written by reading the head of each pull request. Nothing was checked out, merged or run (see section 7).
- To list every open line in the repository: `grep -rn "Pending #" docs`.

## 4. Known limitations

408 rows are collected below: 14 rated high, 164 medium and 230 low. Because a defect that touches several chapters has a row in each, the count is of rows and not of distinct defects; [security.md](security.md#19-known-limitations) holds 33 distinct ones with their own numbers.

### 4.1 The scale

"Risk" is an assessment of the effect on a deployed system, not a measurement.

- **high**: stops a whole function for the people who use it, can end a process, or can expose money or personal data.
- **medium**: wrong or degraded behaviour under a named condition, or a missing control, with a manual way round.
- **low**: naming, comments, tests, hygiene, a limit that does not affect a user today, or code that is not running.

For an item that has an `L-` number, the risk is the one in [security.md](security.md#19-known-limitations). For every other item the rating is made on this page on the same scale. Several ratings rest on reading the code and were not reproduced; the item's own chapter says which.

"Issue / PR" lists the GitHub numbers the chapter names for the item, and the register entries (`C-nnn`) or decisions (`AD-nnn`) where the chapter gives them. "none" means the chapter names none. "(closed)" marks an issue that is closed on GitHub, according to the chapter; "not done" means the chapter lists work from that issue that is still missing.

### 4.2 Items rated high

| Chapter and item | Summary | Issue / PR | Same as |
| --- | --- | --- | --- |
| [security.md](security.md#19-known-limitations), item L-1 | The scanner writes a backslash and 0 instead of a NUL after zINSTREAM; clamd cannot parse the command, so every upload through a reachable clamd ... | #205, PR #225, #229 | - |
| [security.md](security.md#19-known-limitations), item L-2 | The staging compose file gives CLAMAV_HOST and CLAMAV_PORT only to the storage-init service, which never reads them, and .env.example lists neither; ... | #208, PR #236 | - |
| [security.md](security.md#19-known-limitations), item L-10 | The pg pool that Better Auth uses has no error listener; pg-pool emits error on the pool when an idle client fails, and an unhandled error event ends ... | none | - |
| [authentication.md](authentication.md#known-limitations), item 1 | The replacement routes need a session that the customer they are for cannot have | none |  |
| [authentication.md](authentication.md#known-limitations), item 9 | The Better Auth pg pool has no error listener | none | L-10 |
| [api/README.md](api/README.md#132-known-limitations-of-the-code), item 10 | ClamAvScanner writes "zINSTREAM\\0", which is the command name followed by the two characters backslash and zero, where a NUL byte is meant | #205, PR #225, #247 | L-1 |
| [api/auth-customer.md](api/auth-customer.md#known-limitations), item 1 | The replacement routes need a session that the customer they are for cannot have | none |  |
| [api/intake-staff.md](api/intake-staff.md#20-known-limitations), item 10 | Uploads depend on a scanner that does not work on main, and its failures are silent | #205, PRs #225, #229, #247, #246 | L-1, L-3 |
| [api/offering.md](api/offering.md#13-known-limitations-of-the-code), item 3 | The ClamAV scanner writes zINSTREAM followed by a backslash and the digit 0 instead of a NUL byte (the source line reads Buffer.from("zINSTREAM\\0"), ... | #205, PRs #225 and #229 | L-1 |
| [configuration.md](configuration.md#8-known-limitations), item L3 | CLAMAV_HOST and CLAMAV_PORT are set only on the one-shot storage-init service, which never reads them; the API falls back to 127.0.0.1 when ... | #208, C-014 | L-2 |
| [operations.md](operations.md#15-known-limitations), item O13 | ClamAV cannot be used on main (#225, #229), the staging API has no CLAMAV_HOST unless the host file sets it (#208), and clamd does not flag files ... | #205, #208, #246, #247, C-014 | L-1, L-2 |
| [integrations.md](integrations.md#18-known-limitations), item 1 | No error listener on the Better Auth pg pool | none | L-10 |
| [integrations.md](integrations.md#18-known-limitations), item 7 | The ClamAV scanner is broken on main, unobservable and unconfigured on staging | #205, #208, #246, #247; PRs #225, #229, #236 | L-1, L-2, L-3 |
| [modules/auth.md](modules/auth.md#11-known-limitations), item 3 | The Postgres pool Better Auth uses has no error listener; an idle-client error is an unhandled error event on an EventEmitter and ends the process | none | L-10 |

### 4.3 All items by chapter

#### security.md section 19

The thirty-three defects of the security chapter, with the risk and the tracker numbers that chapter gives. Items in other chapters that describe the same defect carry the `L-` number in their "Same as" column.

| ID | Area | Summary | Risk | Issue / PR |
| --- | --- | --- | --- | --- |
| [L-1](security.md#19-known-limitations) | Uploads | The scanner writes a backslash and 0 instead of a NUL after zINSTREAM; clamd cannot parse the command, so every upload through a reachable clamd ... | high | #205, PR #225, #229 |
| [L-2](security.md#19-known-limitations) | Uploads, config | The staging compose file gives CLAMAV_HOST and CLAMAV_PORT only to the storage-init service, which never reads them, and .env.example lists neither; ... | high | #208, PR #236 |
| [L-3](security.md#19-known-limitations) | Uploads | A scanner failure of any cause (unknown command, refused connection, timeout, oversize reply) produces the same 503, with no cause and no log; ... | medium | #247, #246 |
| [L-4](security.md#19-known-limitations) | Idempotency | A key is scoped to (key, endpoint): another account, or another :offering_id or :reservation_id, with the same key and body is answered with the ... | medium | PR #244, C-006 |
| [L-5](security.md#19-known-limitations) | Idempotency | No in-flight lock: two concurrent first requests with one key both run the handler | medium | none |
| [L-6](security.md#19-known-limitations) | Idempotency | expires_at is written (48 hours) but never read or purged, so a stored response, including a 4xx, replays for as long as the row exists | low | C-006 |
| [L-7](security.md#19-known-limitations) | Rate limiting | Rate limiting needs Redis at boot, never reconnects, and fails open on every store error; staging defines no Redis service | medium | #175 |
| [L-8](security.md#19-known-limitations) | Rate limiting | The tightened tier covers only authentication surfaces; reservation creation, reconfirmation, finalization, wallet registration, transfer preparation ... | medium | none |
| [L-9](security.md#19-known-limitations) | Sessions | POST /v1/auth/sessions/devices/:jkt/revoke revokes only the caller's sessions but then cancels the pending and signed signing requests of the active ... | medium | #213, PR #234 |
| [L-10](security.md#19-known-limitations) | Availability | The pg pool that Better Auth uses has no error listener; pg-pool emits error on the pool when an idle client fails, and an unhandled error event ends ... | high | none |
| [L-11](security.md#19-known-limitations) | Availability | Shutdown has no force-exit timer; its callback is async over Promise.all, so one failing task becomes an unhandled rejection; no unhandledRejection ... | medium | none |
| [L-12](security.md#19-known-limitations) | Device auth | The two Google calls of the Play Integrity check have no timeout, a new access token is fetched per decode, and any failure is reported to the client ... | medium | none |
| [L-13](security.md#19-known-limitations) | Email | The SMTP transport has no timeouts | medium | none |
| [L-14](security.md#19-known-limitations) | Responses | A response that fails its schema is answered 422 validation.invalid_field with the internal field path and is not logged; a code comment promises 500 | medium | PR #244, #245 |
| [L-15](security.md#19-known-limitations) | Documents | Object removal is best effort and silent; retention_until is never read and no purge job exists; the private bucket is versioned, so a removal may ... | medium | none |
| [L-16](security.md#19-known-limitations) | Uploads | Uploads are buffered twice in memory (about 200 MB at the cap), with no concurrency cap and no memory limit on the api container; staff downloads ... | medium | none |
| [L-17](security.md#19-known-limitations) | Logging | x-trace-id is accepted without validation and reaches responses, logs, audit rows and, unmasked, the dead-letter alert message | low | #217 |
| [L-18](security.md#19-known-limitations) | Better Auth mount | No body size limit on /api/auth/\* (library, derived); every /api/auth/\* request, reads included, shares one 10-per-minute-per-IP bucket with the ... | medium | none |
| [L-19](security.md#19-known-limitations) | Fresh authentication | /link-social is outside the fresh-authentication list; the Better Auth hook skips staff sessions; the window is 5 minutes where the record says 15 | medium | none |
| [L-20](security.md#19-known-limitations) | Authorization | The customer population check is a per-router convention missing from four customer routers; on the reservation routes idempotency runs before it | low | none |
| [L-21](security.md#19-known-limitations) | Rate limiting | INCR and EXPIRE are separate calls; a failure of the second leaves a counter with no expiry (derived) | low | none |
| [L-22](security.md#19-known-limitations) | Configuration | NODE_ENV defaults to development and every production refinement is skipped when it is unset; staging does not pin it; placeholder secrets from ... | medium | #214, PR #238 |
| [L-23](security.md#19-known-limitations) | Audit | audit.audit_log has no immutability trigger and one path rewrites a row; ip_address_hash and user_agent_hash are never written; no read is audited | medium | none |
| [L-24](security.md#19-known-limitations) | Audit | A dead-letter replay leaves one log line and no audit row | low | #209, PR #233 |
| [L-25](security.md#19-known-limitations) | Deployment | The api and worker containers run as root; the runtime install keeps dev tooling (devOptional packages); the staging api publishes host port 3000 and ... | medium | none |
| [L-26](security.md#19-known-limitations) | Self-custody | The api needs CHAIN_OPERATOR_PRIVATE_KEY in its environment for the escrow gate although it never signs; CHAIN_NETWORK=base is accepted in any ... | medium | C-008 |
| [L-27](security.md#19-known-limitations) | Money | The staff readiness policy sums EUR with floating-point Number | low | #122 (closed) |
| [L-28](security.md#19-known-limitations) | Validation | Header and query inputs of the intake document routes are not schema-validated; NaN is passed to a Prisma where (not exercised) | low | none |
| [L-29](security.md#19-known-limitations) | Availability | The S3 clients are built without timeouts and the database pools without a connection timeout; with an exhausted pool /health/ready waits instead of ... | low | none |
| [L-30](security.md#19-known-limitations) | Headers | Cache-Control is set per handler; 14 of 28 router files set none, among them customer intake and staff account search | low | none |
| [L-31](security.md#19-known-limitations) | Origins | AUTH_TRUSTED_ORIGINS defaults to http://localhost:3000 with no production refinement | low | none |
| [L-32](security.md#19-known-limitations) | CSRF | No CSRF token on /v1 or /internal/v1; cookie sessions rely on SameSite=Lax, and the cookie's parent Domain reaches sibling subdomains (derived) | low | none |
| [L-33](security.md#19-known-limitations) | Rate limiting | The baseline limiter is mounted on the whole /v1/offerings prefix before authentication and keyed by IP, so authenticated reservation, ... | medium | none |

#### authentication.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](authentication.md#known-limitations) | The replacement routes need a session that the customer they are for cannot have | high | none |  |
| [2](authentication.md#known-limitations) | Device revoke cancels signing requests without checking the caller owns the device | medium | #213, PR #234 | L-9 |
| [3](authentication.md#known-limitations) | The same route does not mark the device revoked | medium | none |  |
| [4](authentication.md#known-limitations) | Device replacement ends no session | low | none |  |
| [5](authentication.md#known-limitations) | auth.login_methods is not kept in step with linking | low | none |  |
| [6](authentication.md#known-limitations) | One shared tight rate-limit bucket per IP | medium | #175 | L-18 |
| [7](authentication.md#known-limitations) | GET /v1/app/config has no rate limiter and writes a replay row per call | low | none |  |
| [8](authentication.md#known-limitations) | The Play Integrity decoder has no timeout and hides its failure reason | medium | none | L-12 |
| [9](authentication.md#known-limitations) | The Better Auth pg pool has no error listener | high | none | L-10 |
| [10](authentication.md#known-limitations) | account.identityStrategy is not a Better Auth 1.7.2 option | low | none |  |
| [11](authentication.md#known-limitations) | Signing requests: the attestation is required by the schema and ignored by the handler | low | #220 |  |
| [12](authentication.md#known-limitations) | The device ceremonies are reachable twice | low | none |  |
| [13](authentication.md#known-limitations) | E2 stores no model, OS version or app version | low | none |  |
| [14](authentication.md#known-limitations) | deployment_identity.environment reports NODE_ENV | low | none |  |
| [15](authentication.md#known-limitations) | Misleading error names | low | none |  |
| [16](authentication.md#known-limitations) | A dead development file ships in the image | low | none |  |
| [17](authentication.md#known-limitations) | DPOP_PHASE1_CUTOVER_AT has a wrong comment | low | none |  |
| [18](authentication.md#known-limitations) | The trace id is trusted as sent | low | #217 | L-17 |
| [19](authentication.md#known-limitations) | A superseded device-replacement code counts as a completed replacement for the cooldown | medium | none |  |
| [20](authentication.md#known-limitations) | Device revoke can stop halfway with 500 | medium | none |  |
| [21](authentication.md#known-limitations) | The ID-token exchange does not require a nonce | medium | none |  |
| [22](authentication.md#known-limitations) | auth.login_methods.linked_via_fresh_auth is always true | low | none |  |

#### staff-access.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](staff-access.md#known-limitations) | The only administrator cannot be recovered | medium | none |  |
| [2](staff-access.md#known-limitations) | Nothing keeps one administrator in place | medium | none |  |
| [3](staff-access.md#known-limitations) | An offboarded identity, or an account whose last role was revoked, cannot be restored | low | none |  |
| [4](staff-access.md#known-limitations) | A staff session has no absolute lifetime | medium | none |  |
| [5](staff-access.md#known-limitations) | Registering a second step-up credential does not protect against losing the passkey | low | none |  |
| [6](staff-access.md#known-limitations) | Guards are attached by hand | medium | none |  |
| [7](staff-access.md#known-limitations) | A suspended partner organisation changes nothing for its staff | medium | none |  |
| [8](staff-access.md#known-limitations) | Staff rows are never cleaned up | low | none |  |
| [9](staff-access.md#known-limitations) | A check-then-insert race grants the same role twice | low | none |  |
| [10](staff-access.md#known-limitations) | The rate limits that protect the staff entry points let requests through when the store errors | medium | #175 | L-7 |
| [11](staff-access.md#known-limitations) | User verification is not enforced at passkey sign-in | medium | none |  |

#### api/README.md section 13.2

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/README.md#132-known-limitations-of-the-code) | x-trace-id is accepted from the caller with no length or character check and flows into logs, audit rows, job payloads and the dead-letter alert line | low | #217 | L-17 |
| [2](api/README.md#132-known-limitations-of-the-code) | Rate limiting fails open on a store error and is off for the life of the process when Redis is unreachable at boot | medium | #175 | L-7 |
| [3](api/README.md#132-known-limitations-of-the-code) | The rate-limit counter increments and then sets the expiry in two calls | low | none | L-21 |
| [4](api/README.md#132-known-limitations-of-the-code) | The baseline IP bucket also counts authenticated requests under /v1/offerings; with TRUST_PROXY unset behind a proxy every caller shares it | medium | none | L-33 |
| [5](api/README.md#132-known-limitations-of-the-code) | A response that fails its own schema is answered as 422 validation.invalid_field with internal paths in field_errors, and is not logged | medium | PRs #244 and #245 | L-14 |
| [6](api/README.md#132-known-limitations-of-the-code) | The idempotency key is not scoped to account or path, has no in-flight lock, and its retention is not applied (section 10.3) | medium | PR #244 | L-4, L-5, L-6 |
| [7](api/README.md#132-known-limitations-of-the-code) | GET /v1/app/config is unauthenticated, unthrottled, and writes a replay row for every request | low | none |  |
| [8](api/README.md#132-known-limitations-of-the-code) | Uploads are held in memory up to 100 MB per request before scanning | medium | none | L-16 |
| [9](api/README.md#132-known-limitations-of-the-code) | The staging .env.staging can change what is mounted and is not visible in the repository | medium | #208, PR #236 |  |
| [10](api/README.md#132-known-limitations-of-the-code) | ClamAvScanner writes "zINSTREAM\\0", which is the command name followed by the two characters backslash and zero, where a NUL byte is meant | high | #205, PR #225, #247 | L-1 |
| [11](api/README.md#132-known-limitations-of-the-code) | The handlers of the intake, own-session, login-method, device-replacement and signing-request routers read only the account id from the auth context ... | low | none | L-20 |

#### api/better-auth.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/better-auth.md#known-limitations) | The ID-token exchange does not require a nonce | medium | none |  |
| [2](api/better-auth.md#known-limitations) | link-social needs no fresh authentication | medium | none | L-19 |
| [3](api/better-auth.md#known-limitations) | One shared tight bucket for the whole prefix | medium | #175 | L-18 |
| [4](api/better-auth.md#known-limitations) | Linking and unlinking leave auth.login_methods and the audit trail behind | low | none |  |
| [5](api/better-auth.md#known-limitations) | The device ceremonies are reachable twice | low | none |  |
| [6](api/better-auth.md#known-limitations) | A session can read the account's Google or Apple tokens | medium | none |  |
| [7](api/better-auth.md#known-limitations) | The user object carries staff-written fields | low | none |  |
| [8](api/better-auth.md#known-limitations) | account.identityStrategy is not an option of Better Auth 1.7.2 | low | none |  |
| [9](api/better-auth.md#known-limitations) | GET /api/auth/error redirects to a path this API does not serve | low | none |  |

#### api/auth-customer.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/auth-customer.md#known-limitations) | The replacement routes need a session that the customer they are for cannot have | high | none |  |
| [2](api/auth-customer.md#known-limitations) | A superseded code counts as a completed replacement for the cooldown | medium | none |  |
| [3](api/auth-customer.md#known-limitations) | Device revoke cancels signing requests without checking that the caller owns the device | medium | #213, PR #234 | L-9 |
| [4](api/auth-customer.md#known-limitations) | Device revoke can stop halfway with 500 | medium | none |  |
| [5](api/auth-customer.md#known-limitations) | The same route does not mark the device revoked | medium | none |  |
| [6](api/auth-customer.md#known-limitations) | auth.login_methods is not kept in step with linking and unlinking | low | none |  |
| [7](api/auth-customer.md#known-limitations) | Two simultaneous account-closure requests can both be stored as pending | low | none |  |
| [8](api/auth-customer.md#known-limitations) | Device replacement ends no session | low | none |  |
| [9](api/auth-customer.md#known-limitations) | GET /v1/app/config has no rate limiter and writes a replay row per call | low | none |  |
| [10](api/auth-customer.md#known-limitations) | The Play Integrity decoder has no timeout and hides its failure reason | medium | none | L-12 |
| [11](api/auth-customer.md#known-limitations) | E2 stores no model, OS version or app version | low | none |  |
| [12](api/auth-customer.md#known-limitations) | Signing requests: the attestation is required by the schema and ignored by the handler | low | #220 |  |
| [13](api/auth-customer.md#known-limitations) | The routes that read only accountId accept a staff session | low | none | L-20 |
| [14](api/auth-customer.md#known-limitations) | A trace id is trusted as sent | low | #217 | L-17 |
| [15](api/auth-customer.md#known-limitations) | deployment_identity.environment reports NODE_ENV | low | none |  |

#### api/auth-staff.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/auth-staff.md#known-limitations) | An unknown practice or firm id ends in a 500 | low | none |  |
| [2](api/auth-staff.md#known-limitations) | The staging single-reviewer mode cannot complete a decision | medium | #214, PR #238, C-013 |  |
| [3](api/auth-staff.md#known-limitations) | A recovery case does not require the Didit verification to have succeeded | medium | none |  |
| [4](api/auth-staff.md#known-limitations) | Completing a recovery case whose account holds a staff role cannot send its link | low | none |  |
| [5](api/auth-staff.md#known-limitations) | Closure approval deletes the customer's sessions before the conditional update | medium | none |  |
| [6](api/auth-staff.md#known-limitations) | Check-then-insert without a unique index | low | none |  |
| [7](api/auth-staff.md#known-limitations) | Unknown ids answer 404 on two routes and 409 on three | low | none |  |
| [8](api/auth-staff.md#known-limitations) | The email-sending routes have no cooldown | low | none |  |
| [9](api/auth-staff.md#known-limitations) | The limiters let requests through when the store errors | medium | #175 | L-7 |

#### api/intake-customer.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/intake-customer.md#known-limitations) | An applicant cannot withdraw a case | low | none |  |
| [2](api/intake-customer.md#known-limitations) | An applicant cannot edit a draft | low | none |  |
| [3](api/intake-customer.md#known-limitations) | A customer cannot upload or download a document, and the references in a submission are not checked | low | none |  |
| [4](api/intake-customer.md#known-limitations) | A case that staff return to draft cannot be submitted again | medium | none |  |
| [5](api/intake-customer.md#known-limitations) | An answer is accepted after due_at | low | none |  |
| [6](api/intake-customer.md#known-limitations) | No notification on publication, expiry, decision or message | low | none |  |
| [7](api/intake-customer.md#known-limitations) | Reminders are not recorded and a failed send is not isolated | low | none |  |
| [8](api/intake-customer.md#known-limitations) | country_code is any two characters | low | none |  |
| [9](api/intake-customer.md#known-limitations) | Integer property fields have no upper bound | low | none |  |
| [10](api/intake-customer.md#known-limitations) | extract_dated is not checked | low | none |  |
| [11](api/intake-customer.md#known-limitations) | The applicant lane returns author_account_id for every message | low | none |  |
| [12](api/intake-customer.md#known-limitations) | A message can be posted at any stage | low | none |  |
| [13](api/intake-customer.md#known-limitations) | Creating and posting are not idempotent | low | none |  |
| [14](api/intake-customer.md#known-limitations) | A staff session passes the authentication on these routes | low | none | L-20 |
| [15](api/intake-customer.md#known-limitations) | The baseline limiter fails open and does not exist without a rate-limit store | medium | #175 | L-7 |
| [16](api/intake-customer.md#known-limitations) | The inbound x-trace-id is echoed without validation or bound | low | #217 | L-17 |
| [17](api/intake-customer.md#known-limitations) | A response that fails its own schema is a 422 | medium | none | L-14 |
| [18](api/intake-customer.md#known-limitations) | Business days ignore public holidays | low | none |  |
| [19](api/intake-customer.md#known-limitations) | The order of rooms in a response can differ from the order submitted | low | none |  |
| [20](api/intake-customer.md#known-limitations) | A malformed intake.minimum_property_value_eur row is answered as a client error | low | none |  |
| [21](api/intake-customer.md#known-limitations) | A draft that staff create or submit is recorded as the applicant's own act | low | none |  |

#### api/intake-staff.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/intake-staff.md#20-known-limitations) | A staff-created draft and a staff submit do not record the staff member, and the submit skips the checks | medium | none |  |
| [2](api/intake-staff.md#20-known-limitations) | A case returned to draft cannot be submitted again | medium | none |  |
| [3](api/intake-staff.md#20-known-limitations) | A case reopened with reopen_pre_offering and approved again gets no open offering | medium | none |  |
| [4](api/intake-staff.md#20-known-limitations) | reopen_final_offering_review keeps the partners' completion times | low | none |  |
| [5](api/intake-staff.md#20-known-limitations) | Document references are free text and uploads are not linked to evidence | low | none |  |
| [6](api/intake-staff.md#20-known-limitations) | Deleted objects can stay in the bucket | medium | none | L-15 |
| [7](api/intake-staff.md#20-known-limitations) | Closing a case does not resolve its published information request | low | none |  |
| [8](api/intake-staff.md#20-known-limitations) | A partner's history page can be empty, or cut short, with no way forward | medium | none |  |
| [9](api/intake-staff.md#20-known-limitations) | A suspended organisation, and an assignment, change less than they appear to | low | none |  |
| [10](api/intake-staff.md#20-known-limitations) | Uploads depend on a scanner that does not work on main, and its failures are silent | high | #205, PRs #225, #229, #247, #246 | L-1, L-3 |
| [11](api/intake-staff.md#20-known-limitations) | Whole files are held in memory in both directions, with no cap on concurrency | medium | none | L-16 |
| [12](api/intake-staff.md#20-known-limitations) | Inputs read from headers and the query string are not schema-checked | low | none | L-28 |
| [13](api/intake-staff.md#20-known-limitations) | Some codes are free text | low | none |  |
| [14](api/intake-staff.md#20-known-limitations) | Closing a case overwrites the decision's notes | low | none |  |
| [15](api/intake-staff.md#20-known-limitations) | A manual handoff retry is not attributed | low | none |  |
| [16](api/intake-staff.md#20-known-limitations) | The case history is not complete, and its order is not the sequence | low | none |  |
| [17](api/intake-staff.md#20-known-limitations) | The correction preview hides reasons and advertises a missing command | low | none |  |
| [18](api/intake-staff.md#20-known-limitations) | A retry of a correction request with the same Idempotency-Key answers 409, not the stored operation | low | C-006 |  |
| [19](api/intake-staff.md#20-known-limitations) | An operation whose execution did not run blocks the case | medium | none |  |
| [20](api/intake-staff.md#20-known-limitations) | The readiness projection sums money as floating-point numbers | low | none | L-27 |
| [21](api/intake-staff.md#20-known-limitations) | Vocabulary is not uniform | low | none |  |
| [22](api/intake-staff.md#20-known-limitations) | Some state-changing routes write no audit row | medium | #131 |  |
| [23](api/intake-staff.md#20-known-limitations) | A staff-created case accepts any account as applicant | low | none |  |
| [24](api/intake-staff.md#20-known-limitations) | The caller's trace id is not bounded, and the limiter is not guaranteed | medium | #217, #175 | L-7, L-17 |
| [25](api/intake-staff.md#20-known-limitations) | The photo count of a deleted room includes the thumbnails | low | none |  |

#### api/offering.md section 13

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/offering.md#13-known-limitations-of-the-code) | One stored media URL that fails the response validator turns the whole list page, or the whole detail, into 422 validation.invalid_field, and the ... | medium | #211, PR #243 |  |
| [2](api/offering.md#13-known-limitations-of-the-code) | According to issue #218, the media validator accepts a URL with credentials or control characters, and the value is stored as given (the validator is ... | low | #218 |  |
| [3](api/offering.md#13-known-limitations-of-the-code) | The ClamAV scanner writes zINSTREAM followed by a backslash and the digit 0 instead of a NUL byte (the source line reads Buffer.from("zINSTREAM\\0"), ... | high | #205, PRs #225 and #229 | L-1 |
| [4](api/offering.md#13-known-limitations-of-the-code) | A scanner failure of any kind (refused connection, timeout, bad reply) is one 503 with no cause and no log line | medium | #247 | L-3 |
| [5](api/offering.md#13-known-limitations-of-the-code) | Archives that exceed clamd's scan limits are not flagged by the configuration in the repository | medium | #246 | L-3 |
| [6](api/offering.md#13-known-limitations-of-the-code) | An upload is read fully into memory (a chunk list, then Buffer.concat into a second buffer while the list is still in scope, up to 100 MiB of file) ... | medium | none | L-16 |
| [7](api/offering.md#13-known-limitations-of-the-code) | A failed delete of an object after a failed metadata insert is swallowed silently, so an orphan object can remain; no purge job exists | medium | none | L-15 |
| [8](api/offering.md#13-known-limitations-of-the-code) | A superseded pack's documents are readable only through disclosure_pack_version_at_reservation; the pack the investor reconfirmed against ... | low | none |  |
| [9](api/offering.md#13-known-limitations-of-the-code) | Reconfirmation reminders are sent to every awaiting_reconfirmation reservation whether or not a reconfirmation is currently possible, including after ... | low | #248 |  |
| [10](api/offering.md#13-known-limitations-of-the-code) | The publish route does not compare the stated document_type with the type stored on the upload | low | none |  |
| [11](api/offering.md#13-known-limitations-of-the-code) | The offering_id in the reconfirm path is parsed and ignored | low | none |  |
| [12](api/offering.md#13-known-limitations-of-the-code) | A retry of a hold that consumed the last remaining capacity is refused by the advisory checks before the key lookup | low | PR #244 |  |
| [13](api/offering.md#13-known-limitations-of-the-code) | The shared idempotency middleware replays a stored 4xx for the same key and body, scopes the key to the endpoint only, has no in-flight lock, and ... | medium | PR #244 | L-4, L-5, L-6 |
| [14](api/offering.md#13-known-limitations-of-the-code) | A response that fails its own schema is answered as 422 validation.invalid_field and not logged | medium | PRs #244, #245 | L-14 |
| [15](api/offering.md#13-known-limitations-of-the-code) | The 90% funding tolerance is a constant, and the credited amount is recorded as amount_eurc only for a funded outcome | medium | #172 |  |
| [16](api/offering.md#13-known-limitations-of-the-code) | The Coinbase webhook payload keys are assumed and no real signed delivery has been checked, so the webhook path may acknowledge deliveries it cannot ... | medium | #173 |  |
| [17](api/offering.md#13-known-limitations-of-the-code) | The funding rail is closed on every deployment that does not set RESERVATION_FUNDING_RAIL_ENABLED=true; the Coinbase live EUR and Base support is a ... | low | #7 |  |
| [18](api/offering.md#13-known-limitations-of-the-code) | The staging anchor in docker-compose.staging.yml does not pass the COINBASE_\* variables, so whether the reservation and webhook routes exist on ... | medium | #173 |  |
| [19](api/offering.md#13-known-limitations-of-the-code) | An escrow-gated offering refuses reservations until the IPO escrow campaign is observed open; the pre-existing job that opens campaigns automatically ... | medium | #176 |  |
| [20](api/offering.md#13-known-limitations-of-the-code) | A case reopened with the intake correction reopen_pre_offering and approved again gets no open offering: the handoff job finds the existing PIV and ... | medium | none |  |

#### api/platform.md

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/platform.md#known-limitations) | GET /v1/investor-profile reports payment_account_ready: true for a pending wallet claim that reservation creation treats as no wallet, so the two ... | medium | none |  |
| [2](api/platform.md#known-limitations) | A response that fails its schema, for example a stored enum value outside the lists above, is answered as 422 validation.invalid_field with internal ... | medium | PRs #244 and #245 | L-14 |
| [3](api/platform.md#known-limitations) | The profile and the activity lists convert an unknown stored status into a plain Error (500 internal.unexpected) for the whole request | medium | none |  |
| [4](api/platform.md#known-limitations) | The positions cursor follows a nullable, mutable key (activated_at) | low | none |  |
| [5](api/platform.md#known-limitations) | The preferences are stored but nothing reads them, so changing them has no effect on e-mail or formatting | low | none |  |
| [6](api/platform.md#known-limitations) | The proof-of-address start can leave a row creating for up to the next hourly run after 15 minutes | low | none |  |
| [7](api/platform.md#known-limitations) | The worker probe port is a constant, and the probe answers 503 for any URL with a query string | low | none |  |
| [8](api/platform.md#known-limitations) | GET /health/ready runs a database query for every call and has no limiter | low | none |  |
| [9](api/platform.md#known-limitations) | GET /internal/v1/accounts returns contact emails without Cache-Control: no-store | low | none |  |

#### api/wallet.md section 9

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](api/wallet.md#9-known-limitations-of-the-code) | A chain read failure on GET .../wallet/balance is a 500 internal.unexpected, while the same failure on transfer preparation is a 503 ... | medium | #155, PR #239 |  |
| [2](api/wallet.md#9-known-limitations-of-the-code) | The balance route answers for a pending claim's address; transfer preparation does not | low | AD-282 |  |
| [3](api/wallet.md#9-known-limitations-of-the-code) | The capital and the token balances are two unpinned calls, so they can differ from the snapshot of a later transfer response | low | none |  |
| [4](api/wallet.md#9-known-limitations-of-the-code) | No check at boot that the RPC serves the configured chain or that the configured addresses hold contract code | medium | #152, PR #240 |  |
| [5](api/wallet.md#9-known-limitations-of-the-code) | A mixed-case address with a wrong EIP-55 checksum is accepted as a registered address and as a recipient, because lowercasing discards the checksum; ... | medium | none |  |
| [6](api/wallet.md#9-known-limitations-of-the-code) | The freshness probe runs for every valid POST, before the registry and KYC checks; if its repository lookup fails the answer is 500 even for a ... | low | none |  |
| [7](api/wallet.md#9-known-limitations-of-the-code) | The 404 wallet.piv_not_held detail says "minted token position", but the check is a position row with a token id; a PIV that was never minted can ... | low | none |  |
| [8](api/wallet.md#9-known-limitations-of-the-code) | A response that fails its own schema is answered 422 validation.invalid_field and not logged; the comment on requestWalletTransferResponseSchema says ... | medium | PRs #244, #245 | L-14 |
| [9](api/wallet.md#9-known-limitations-of-the-code) | The staff router throws a plain Error for a missing auth context, which surfaces as internal.unexpected instead of authentication.context_missing | low | none |  |
| [10](api/wallet.md#9-known-limitations-of-the-code) | The transfer simulation covers the inner safeTransferFrom only; it does not simulate a UserOperation (bundler, paymaster, owner signature, gas) | low | none |  |
| [11](api/wallet.md#9-known-limitations-of-the-code) | The RPC provider must accept an EIP-1898 block hash with requireCanonical; a provider that does not turns every transfer request into 503 ... | medium | none |  |
| [12](api/wallet.md#9-known-limitations-of-the-code) | Delivery of the wallet registry alerts to a person is not built: the events reach the worker log only | low | #150 (closed) |  |

#### data-model.md section 10

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [L1](data-model.md#10-known-limitations) | Prisma's schema-versus-database comparison fails with P4002 (reported by the audit), so drift between schema.prisma and the migrations is checked ... | medium | none |  |
| [L2](data-model.md#10-known-limitations) | The migration 20261121090000_escrow_mint_intent_nonce is stamped in the future, so a migration written with an earlier stamp sorts before it on new ... | medium | none |  |
| [L3](data-model.md#10-known-limitations) | Two directories share the stamp 20260918100000; their order is decided by the rest of the name, and nothing stops a third | low | none |  |
| [L4](data-model.md#10-known-limitations) | A migration header names a stamp (20261117202500) that no directory has | low | none |  |
| [L5](data-model.md#10-known-limitations) | Nine checks are NOT VALID and no migration validates them, so existing rows are unchecked on any database where nobody ran VALIDATE CONSTRAINT. ... | medium | none |  |
| [L6](data-model.md#10-known-limitations) | audit.idempotency_keys is never purged and its expires_at is never compared: a stored response (written with a 48-hour expires_at) is replayed for as ... | low | none | L-6 |
| [L7](data-model.md#10-known-limitations) | The idempotency key is (idempotency_key, endpoint); account_id is stored but not part of the lookup, so the same key and endpoint from another ... | medium | #122 (closed, not done) | L-4 |
| [L8](data-model.md#10-known-limitations) | money.money_events has no unique constraint on (provider, provider_reference); duplicates are prevented by an application check under the reservation ... | medium | #122 |  |
| [L9](data-model.md#10-known-limitations) | No job deletes or purges platform.stored_documents rows or their objects after retention_until; a comment says a purge job retries object deletion, ... | medium | none |  |
| [L10](data-model.md#10-known-limitations) | Expired rows of auth.staff_invitations, auth.staff_webauthn_challenges, auth.device_replacement_codes and auth.sessions are never purged (section 6.3) | low | none |  |
| [L11](data-model.md#10-known-limitations) | With the staging-only single-reviewer mode on, the recovery decision update can write the same account into both reviewer columns, which ... | low | none |  |
| [L12](data-model.md#10-known-limitations) | Offering media URLs are stored after only a URL and HTTPS check, and one stored malformed value fails the whole public offering list on main | low | #218, #211 |  |
| [L13](data-model.md#10-known-limitations) | A schema comment cites AD-097 for the signing request id, and the policy comment says the terminal off-chain status is executed, which the record's ... | low | #220 |  |
| [L14](data-model.md#10-known-limitations) | The append-only triggers do not guard TRUNCATE and are not a privilege boundary; nothing in the repository removes UPDATE, DELETE or TRUNCATE from ... | medium | none |  |
| [L15](data-model.md#10-known-limitations) | Retention of the two money evidence tables and of expired wallet claims is not decided | low | none |  |
| [L16](data-model.md#10-known-limitations) | Schema-only tables: intake.case_integrity_flags, intake.corridor_clearances, intake.legal_execution_events, intake.workstream_assignment_events, ... | low | none |  |
| [L17](data-model.md#10-known-limitations) | The column default of platform.stored_documents.upload_status is quarantined, while every insert writes accepted; a row inserted without the column ... | low | none |  |
| [L18](data-model.md#10-known-limitations) | Foreign key delete rules differ between the migrations and what Prisma would assume, and six foreign keys are invisible to the Prisma schema (section ... | low | none |  |

#### jobs-and-workers.md section 10

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](jobs-and-workers.md#10-known-limitations) | A handler that runs past its 900 s expiration is failed by pg-boss, but its promise is not cancelled and keeps running; no handler reads the abort ... | medium | none |  |
| [2](jobs-and-workers.md#10-known-limitations) | Every thrown error takes the whole retry profile: about 3 hours for an event job, 31 to 62 seconds for a scheduled one | low | none |  |
| [3](jobs-and-workers.md#10-known-limitations) | settlement.finalize_ipo_escrow_campaigns returns normally when a campaign errors, so the job is neither retried nor dead-lettered; the only trace is ... | medium | #206 |  |
| [4](jobs-and-workers.md#10-known-limitations) | settlement.open_ipo_escrow_campaign keeps no transaction hash between attempts, so a retry after a receipt timeout can broadcast openCampaign again, ... | medium | none |  |
| [5](jobs-and-workers.md#10-known-limitations) | The finalizer's search for a mint log reads from block 0 when no block is pinned and sets no upper bound | medium | #219 |  |
| [6](jobs-and-workers.md#10-known-limitations) | case_timers.offering_reconfirmation_window_opened and case_timers.offering_reconfirmation_reminders send the email before they record that it was ... | low | none |  |
| [7](jobs-and-workers.md#10-known-limitations) | maintenance.kyc_renewal and case_timers.applicant_reminders match one calendar day and keep no sent marker, so a retry repeats the emails of the ... | low | none |  |
| [8](jobs-and-workers.md#10-known-limitations) | rental.operating_distribution_sweep fixes the management fee, other expenses and reserve holdback to 0.00, so every distribution it calculates equals ... | low | none |  |
| [9](jobs-and-workers.md#10-known-limitations) | A schedule row is never removed | low | none |  |
| [10](jobs-and-workers.md#10-known-limitations) | A queue whose consumer exists only under a condition has no consumer when the worker lacks it | low | none |  |
| [11](jobs-and-workers.md#10-known-limitations) | A comment in the document upload service says object deletion "can be retried by the purge job". The ownership registry has no such queue, and no ... | low | none |  |
| [12](jobs-and-workers.md#10-known-limitations) | Neither compose file sets stop_grace_period, so Docker's default stop timeout applies (its value, and whether it is shorter than the 30 s pg-boss ... | medium | none | L-11 |
| [13](jobs-and-workers.md#10-known-limitations) | heartbeat.stop(), the cache close and $disconnect() are outside the try; a rejection in the first skips boss.stop() | medium | none | L-11 |
| [14](jobs-and-workers.md#10-known-limitations) | /health/ready proves boot and a turning event loop | low | none |  |
| [15](jobs-and-workers.md#10-known-limitations) | The Redis client of the worker has reconnectStrategy: false; after the first disconnect it never reconnects until the worker restarts | medium | none |  |
| [16](jobs-and-workers.md#10-known-limitations) | The SMTP transport has no timeout option and the Prisma pool no acquire timeout, so a hung dependency is cut off only by the 900 s expiration of the ... | medium | none | L-13 |
| [17](jobs-and-workers.md#10-known-limitations) | The worker parses the whole environment schema, so variables it never reads (BETTER_AUTH_SECRET, DIDIT_CALLBACK_URL, DIDIT_WEBHOOK_SECRET) must be ... | low | none |  |
| [18](jobs-and-workers.md#10-known-limitations) | The worker does not verify the chain id or the contract code at boot; a wrong CHAIN_RPC_URL is found only when a job runs | medium | #152 |  |
| [19](jobs-and-workers.md#10-known-limitations) | Every dead-letter entry is one webhook POST. A scheduled queue that fails on every tick sends one alert per tick; there is no per-queue throttle | medium | #210 |  |
| [20](jobs-and-workers.md#10-known-limitations) | The trace id in a dead-letter alert is the inbound request's value, unvalidated and unbounded, printed in the message line | low | #217 | L-17 |
| [21](jobs-and-workers.md#10-known-limitations) | jobs:replay-dead-letter leaves no audit row | low | #209 | L-24 |
| [22](jobs-and-workers.md#10-known-limitations) | maintenance.kyc_stuck_session_expiry, maintenance.kyc_stuck_session_reconciliation and maintenance.account_recovery_alert have no try, so a failed ... | low | none |  |
| [23](jobs-and-workers.md#10-known-limitations) | /metrics has no # TYPE or # HELP lines, and a metric exists only after the job that sets it has run once | low | none |  |
| [24](jobs-and-workers.md#10-known-limitations) | A queue's name can mislead: maintenance.signing_request_prune marks requests expired and deletes nothing | low | none |  |
| [25](jobs-and-workers.md#10-known-limitations) | A failing every-minute job dead-letters once a minute after the first minute of failure: case_timers.reservation_onramp_poll while Coinbase is down, ... | low | none |  |

#### cli.md section 10

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](cli.md#10-known-limitations) | intake:backfill-events ignores every argument, --help included, and has no dry run; its count of imported events includes rows that already had their ... | low | none |  |
| [2](cli.md#10-known-limitations) | No database script checks that its target is local | medium | none |  |
| [3](cli.md#10-known-limitations) | jobs:replay-dead-letter leaves no audit row; its log line goes to the command's standard error | low | #209 | L-24 |
| [4](cli.md#10-known-limitations) | An invalid or incomplete environment makes every command end with a stack trace and exit code 1, not with its usage exit codes, because ... | low | none |  |
| [5](cli.md#10-known-limitations) | The testnet refusal exists only in settlement:open-ipo-escrow-campaigns; the worker's settlement.open_ipo_escrow_campaign job and the finalizer are ... | medium | C-008 |  |
| [6](cli.md#10-known-limitations) | better-auth.cli.ts is an unused file with a development secret as its fallback, and it ships in dist/ | low | none |  |
| [7](cli.md#10-known-limitations) | tmp/create-dev-intake-fixture.ts deletes and recreates sample intake cases in whatever database DATABASE_URL names, with no check that the database ... | medium | none |  |

#### configuration.md section 8

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [L1](configuration.md#8-known-limitations) | The rule that the anchor is the only route into the staging containers is not what the compose files do; the API and the worker also load every line ... | medium | #208, #173 |  |
| [L2](configuration.md#8-known-limitations) | 34 of the 97 variables have no anchor entry, so their staging value is whatever the untracked .env.staging holds; no tracked template documents it | medium | none |  |
| [L3](configuration.md#8-known-limitations) | CLAMAV_HOST and CLAMAV_PORT are set only on the one-shot storage-init service, which never reads them; the API falls back to 127.0.0.1 when ... | high | #208, C-014 | L-2 |
| [L4](configuration.md#8-known-limitations) | NODE_ENV is not pinned in the staging compose file and defaults to development in the schema, so production-only rules depend on the host file or the ... | medium | none | L-22 |
| [L5](configuration.md#8-known-limitations) | The maildev web UI is published on every host interface (1080:1080) and staging mail includes staff invitation links, recovery links and device ... | medium | none | L-25 |
| [L6](configuration.md#8-known-limitations) | MINIO_PRIVATE_BUCKET is outside the MinIO all-or-none group, and the schema applies no bucket default; with the other four values set and this one ... | low | none |  |
| [L7](configuration.md#8-known-limitations) | Placeholder values from .env.example pass validation with NODE_ENV=production and APP_ENV=staging: the 42-character BETTER_AUTH_SECRET placeholder, ... | medium | none | L-22 |
| [L8](configuration.md#8-known-limitations) | The API process needs CHAIN_OPERATOR_PRIVATE_KEY in its environment because the escrow-readiness gate tests that the key is present, although the API ... | medium | C-008, AD-240, AD-286 | L-26 |
| [L9](configuration.md#8-known-limitations) | CHAIN_NETWORK accepts base (mainnet) in any environment and base-sepolia in production; no rule ties it to NODE_ENV or APP_ENV. Only the operator ... | medium | C-008, AD-234 | L-26 |
| [L10](configuration.md#8-known-limitations) | No automated check ties the schema, .env.example and the two compose files together | low | none |  |
| [L11](configuration.md#8-known-limitations) | Variables are passed and never read: EMAIL_VERIFICATION_ENABLED in the anchor; DIRECT_DATABASE_URL to the API and worker (read only by ... | low | none |  |
| [L12](configuration.md#8-known-limitations) | Secrets are spread wider than their use: the worker must be given BETTER_AUTH_SECRET, DIDIT_CALLBACK_URL and DIDIT_WEBHOOK_SECRET, the API ... | low | none |  |
| [L13](configuration.md#8-known-limitations) | Blank values are handled differently from variable to variable | low | none |  |
| [L14](configuration.md#8-known-limitations) | Defaults differ across sources: AUTH_TRUSTED_ORIGINS is http://localhost:3000 in the schema, http://localhost:3000,com.vistablox.app:// in ... | low | none |  |
| [L15](configuration.md#8-known-limitations) | Development credentials are committed: the dev Postgres, MinIO and SMTP credentials, with Postgres (5432), the cache (6379) and Mailpit (8025) ... | low | none |  |
| [L16](configuration.md#8-known-limitations) | Stale or wrong statements in the repository: README.md:126 says to fill in BETTER_AUTH_SECRET "at minimum", while a stack started from .env.example ... | low | none |  |
| [L17](configuration.md#8-known-limitations) | Names differ from the design record: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET against GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; ... | low | AD-133, AD-136, AD-142, AD-289, C-013, C-014, C-015 |  |
| [L18](configuration.md#8-known-limitations) | The record gives the API a pooled database connection and the worker a persistent one; the code has one DATABASE_URL for both and no variable for a ... | low | none |  |
| [L19](configuration.md#8-known-limitations) | The queue cadence statements in README.md differ from the worker: line 41 groups the wallet registry watcher under "every 5 minutes" (it runs every ... | low | none |  |
| [L20](configuration.md#8-known-limitations) | The schema comment of DPOP_PHASE1_CUTOVER_AT and the app comment "Undefined leaves DPoP fully off" describe a mode the server never runs in | low | none |  |
| [L21](configuration.md#8-known-limitations) | A queue and its cron entry stay in pg-boss after the variable that created them is removed; no code removes them | low | none |  |
| [L22](configuration.md#8-known-limitations) | The API's /health/ready and the worker's /health/ready do not check Redis, MinIO, ClamAV, SMTP or the chain, so a wrong value for those variables ... | medium | none |  |

#### operations.md section 15

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [O1](operations.md#15-known-limitations) | The application containers run as root: the Dockerfile has no USER | medium | none | L-25 |
| [O2](operations.md#15-known-limitations) | The runtime images install devOptional packages (test runner, bundler, Prisma CLI, TypeScript) that src/ never imports; the size of that install was ... | medium | none | L-25 |
| [O3](operations.md#15-known-limitations) | Base image tags float (node:22-alpine, postgres:18-alpine, valkey/valkey:8-alpine, axllent/mailpit:latest), so a rebuild can change versions | low | none |  |
| [O4](operations.md#15-known-limitations) | maildev publishes its web UI on every interface (1080), and the API publishes 3000 on every interface | medium | none | L-25 |
| [O5](operations.md#15-known-limitations) | The database, MinIO, ClamAV and maildev services have no restart policy, and Docker's restart policy for the application services does not consider ... | low | none |  |
| [O6](operations.md#15-known-limitations) | Neither compose file sets stop_grace_period, so Docker's default timeout applies where pg-boss waits up to 30 s; the API has no forced-exit timer and ... | medium | none | L-11 |
| [O7](operations.md#15-known-limitations) | The health checks cover the database (API) or the boot flag and an event-loop timer (worker) only | low | none |  |
| [O8](operations.md#15-known-limitations) | scripts/deploy/staging.sh validates the compose file but not the application's schema, does not report health, does not name the deployed commit and ... | low | none |  |
| [O9](operations.md#15-known-limitations) | The design record's staging database, proxy, container count, CI migration check and error tracker differ from the repository (table in section 5.5) | low | AD-134, AD-087, AD-142, AD-257 |  |
| [O10](operations.md#15-known-limitations) | No backup, restore or snapshot procedure exists in the repository | medium | AD-140, AD-143, AD-200 |  |
| [O11](operations.md#15-known-limitations) | docker-compose.staging.yml carries a comment that Compose defaults to restart: unless-stopped; the resolved configuration shows no restart value for ... | low | none |  |
| [O12](operations.md#15-known-limitations) | The draw.io diagrams in docs/diagrams no longer match the staging file (a cache service, the maildev binding, the callback prefix and the database ... | low | none |  |
| [O13](operations.md#15-known-limitations) | ClamAV cannot be used on main (#225, #229), the staging API has no CLAMAV_HOST unless the host file sets it (#208), and clamd does not flag files ... | high | #205, #208, #246, #247, C-014 | L-1, L-2 |
| [O14](operations.md#15-known-limitations) | Logs go to the Docker daemon's default sink with no shipper, no error tracker and no metrics scraper; only dead-letter alerts leave the host | medium | AD-088, AD-089, AD-141 |  |

#### integrations.md section 18

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](integrations.md#18-known-limitations) | No error listener on the Better Auth pg pool | high | none | L-10 |
| [2](integrations.md#18-known-limitations) | The Play Integrity decoder has no timeout, no token cache and no usable error | medium | none | L-12 |
| [3](integrations.md#18-known-limitations) | Object deletes swallow their errors, and nothing retries them | medium | none | L-15 |
| [4](integrations.md#18-known-limitations) | Shutdown has no force-exit timer and one rejection ends it badly | medium | none | L-11 |
| [5](integrations.md#18-known-limitations) | No acquisition timeout for plain queries and no statement_timeout | low | none | L-29 |
| [6](integrations.md#18-known-limitations) | SMTP has no timeouts, and several failures vanish | medium | none | L-13 |
| [7](integrations.md#18-known-limitations) | The ClamAV scanner is broken on main, unobservable and unconfigured on staging | high | #205, #208, #246, #247; PRs #225, #229, #236 | L-1, L-2, L-3 |
| [8](integrations.md#18-known-limitations) | Redis never reconnects, fails open, and its counter is not atomic | medium | #175 | L-7, L-21 |
| [9](integrations.md#18-known-limitations) | An RPC URL can reach the api log | medium | none |  |
| [10](integrations.md#18-known-limitations) | The resume lookup in GET /v1/kyc swallows a Didit failure | low | none |  |
| [11](integrations.md#18-known-limitations) | The staging mail catcher's web interface is published on every interface of the host | medium | none | L-25 |
| [12](integrations.md#18-known-limitations) | Uploads and downloads are buffered whole in memory | medium | none | L-16 |
| [13](integrations.md#18-known-limitations) | The application uses the MinIO root credentials in the local and staging stacks | medium | none |  |
| [14](integrations.md#18-known-limitations) | better-auth.cli.ts ships in dist with a default secret | low | none |  |
| [15](integrations.md#18-known-limitations) | Stale comments name a contract function that does not exist | low | none |  |

#### testing.md section 8

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](testing.md#8-known-limitations) | Nine integration files pass only in definition order | low | none |  |
| [2](testing.md#8-known-limitations) | Fixtures that depend on the calendar | low | none |  |
| [3](testing.md#8-known-limitations) | Real-clock tests and counts | low | none |  |
| [4](testing.md#8-known-limitations) | Wall-clock bounds and short sleeps | low | none |  |
| [5](testing.md#8-known-limitations) | Leftover jobs in the shared database | low | none |  |
| [6](testing.md#8-known-limitations) | Shared-database coupling is held together by comments and two tests | low | none |  |
| [7](testing.md#8-known-limitations) | A skipped run looks like a pass | medium | none |  |
| [8](testing.md#8-known-limitations) | Two repeated test titles | low | none |  |
| [9](testing.md#8-known-limitations) | CI covers one fresh path | low | none |  |
| [10](testing.md#8-known-limitations) | No test starts the two processes | low | none |  |
| [11](testing.md#8-known-limitations) | Doubles can hide a wrong wire format | low | none |  |
| [12](testing.md#8-known-limitations) | The coverage block names a provider that is not installed and the report file is not ignored | low | none |  |
| [13](testing.md#8-known-limitations) | Two variables name one database | low | none |  |

#### modules/account.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/account.md#11-known-limitations) | provider_subject of a passkey, google or apple login method is the Better Auth user id, not the provider's own subject, and linked_via_fresh_auth is ... | low | none |  |
| [2](modules/account.md#11-known-limitations) | The email search is an unindexed case-insensitive scan with no limit | low | none |  |
| [3](modules/account.md#11-known-limitations) | protected_contact_email is not unique, so two accounts can share an address and the search returns both | low | none |  |
| [4](modules/account.md#11-known-limitations) | Other modules import this module's repository types, and this module imports a type from auth/infrastructure | low | #122 (closed, not done) |  |
| [5](modules/account.md#11-known-limitations) | The three account status values are declared separately in seven types and schemas and checked by three runtime guards (asAccountStatus in the ... | low | none |  |

#### modules/auth.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/auth.md#11-known-limitations) | The Play Integrity calls (token exchange and decode) are plain fetch with no timeout, and every decode fetches a fresh access token; the only caller ... | medium | none | L-12 |
| [2](modules/auth.md#11-known-limitations) | Mail is sent inside the request; SmtpEmailSender sets no timeout of its own (nodemailer's defaults apply), and a failure is dropped without a log in ... | medium | none | L-13 |
| [3](modules/auth.md#11-known-limitations) | The Postgres pool Better Auth uses has no error listener; an idle-client error is an unhandled error event on an EventEmitter and ends the process | high | none | L-10 |
| [4](modules/auth.md#11-known-limitations) | Revoking sessions by device key cancels pending signing requests of that key without scoping to the caller; the router discards the auth context | medium | #213, PR #234 | L-9 |
| [5](modules/auth.md#11-known-limitations) | The staging single-reviewer recovery mode can fail with a 500, and the staging flags are relaxations the record does not describe | medium | #214, PR #238, C-013 | L-22 |
| [6](modules/auth.md#11-known-limitations) | The signing-request comments cite AD-097, which in the record is a different decision (the minimum property value), and call the terminal off-chain ... | low | #220 |  |
| [7](modules/auth.md#11-known-limitations) | The unbound-session pass of the DPoP check is the documented phase-1 policy: a session with no bound key passes without a proof | low | none |  |
| [8](modules/auth.md#11-known-limitations) | better-auth.cli.ts reads process.env directly with a development secret fallback and a local database URL, ships in dist and is imported by nothing | low | none |  |
| [9](modules/auth.md#11-known-limitations) | The signing-request subsystem is built and tested but off: the flag is hard-coded false, and no code outside tests creates a request | low | none |  |
| [10](modules/auth.md#11-known-limitations) | Other modules import auth's repository types and auth imports account and identity types; the architecture check ignores type-only imports | low | #122 (closed, not done) |  |
| [11](modules/auth.md#11-known-limitations) | A response that fails its schema surfaces as 422 validation.invalid_field with internal field paths and is not logged | medium | #244, #245 | L-14 |

#### modules/health.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/health.md#11-known-limitations) | Readiness checks the database only | low | none |  |
| [2](modules/health.md#11-known-limitations) | Every /health/ready call runs a query; the route has no limiter | low | none |  |
| [3](modules/health.md#11-known-limitations) | The API's shutdown handler calls server.close and then closes its connections; it does not change what /health/ready answers while it drains | low | none |  |
| [4](modules/health.md#11-known-limitations) | The worker's readiness is "ready flag set and a timer tick within 30 seconds"; it does not look at the database, pg-boss or the last job | low | none |  |

#### modules/identity.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/identity.md#11-known-limitations) | The renewal reminder matches exactly one calendar day and the job runs once a day, with no "sent" marker; a day on which the worker is down sends no ... | low | none |  |
| [2](modules/identity.md#11-known-limitations) | GET /v1/kyc calls Didit on every read while a session is open (4-second timeout; a failure gives active_session: null) | low | none |  |
| [3](modules/identity.md#11-known-limitations) | The webhook is verified over the re-serialised JSON of the parsed body, not the raw bytes | medium | none |  |
| [4](modules/identity.md#11-known-limitations) | Stuck sessions that the reconciliation cannot resolve produce only a warning log; the guide's note that nothing is paged predates the dead-letter ... | low | #222 |  |
| [5](modules/identity.md#11-known-limitations) | Other modules import identity's repository and application types; the architecture check ignores type-only imports, so none is reported | low | #122 (closed, not done) |  |
| [6](modules/identity.md#11-known-limitations) | A response that fails its schema surfaces as 422 validation.invalid_field with internal field paths and is not logged | medium | #244, #245 | L-14 |

#### modules/intake.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/intake.md#11-known-limitations) | Closing a case from pre_offering_open closes its offering and cancels its open reservations by writing the offering module's tables from intake's ... | medium | none |  |
| [2](modules/intake.md#11-known-limitations) | intake-labels.ts imports disclosureDocumentTypes and publicOfferingStatuses from the offering domain and does not use them; the architecture check ... | low | #122 (closed, not done) |  |
| [3](modules/intake.md#11-known-limitations) | The readiness policy sums money with Number() (reservation amounts, funded amount, target, percentage) | low | #122 | L-27 |
| [4](modules/intake.md#11-known-limitations) | The readiness policy keeps its own copies of the required evidence and the eleven disclosure document types | low | none |  |
| [5](modules/intake.md#11-known-limitations) | Upload and download buffer the whole file in memory (up to 100 MB, about twice that while scanning); no concurrency cap | medium | none | L-16 |
| [6](modules/intake.md#11-known-limitations) | The scanner call is wrapped in a bare catch that throws a fixed 503 without the cause and without a log | medium | #247 | L-3 |
| [7](modules/intake.md#11-known-limitations) | Deleting the stored object after a database change is .catch(() =&gt; undefined), with a comment about a purge job that does not exist | medium | none | L-15 |
| [8](modules/intake.md#11-known-limitations) | The upload route converts X-Revision-Number with Number(...) and no schema, so a non-numeric header reaches the revision lookup as NaN; the listing ... | low | none | L-28 |
| [9](modules/intake.md#11-known-limitations) | Due dates exclude Saturdays and Sundays only; no holiday calendar | low | none |  |
| [10](modules/intake.md#11-known-limitations) | A missed daily run of the reminder job sends no reminder for that day | low | none |  |
| [11](modules/intake.md#11-known-limitations) | PrismaIntakeRepository is 2743 lines and holds every intake interface | low | none |  |
| [12](modules/intake.md#11-known-limitations) | A response that fails its schema surfaces as 422 validation.invalid_field with internal field paths and is not logged | medium | #244, #245 | L-14 |

#### modules/investor-activity.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/investor-activity.md#11-known-limitations) | One stored value outside the closed lists (a reservation stage, offering status, capital state, position status or property type) fails the whole ... | medium | none |  |
| [2](modules/investor-activity.md#11-known-limitations) | investment_summary.reservation_count counts every reservation of the account, including cancelled and lapsed; only the position count is filtered by ... | low | none |  |
| [3](modules/investor-activity.md#11-known-limitations) | A position created by the reservation flow keeps the status pending_internal_settlement and a null activated_at; no code on main moves an existing ... | medium | none |  |
| [4](modules/investor-activity.md#11-known-limitations) | No index supports the position sort (activated_at, position_id) or the reservation sort (created_at, reservation_id); the account index narrows the ... | low | none |  |
| [5](modules/investor-activity.md#11-known-limitations) | A response that fails its schema surfaces as 422 validation.invalid_field with internal field paths and is not logged (the route uses schema.parse) | medium | #244, #245 | L-14 |
| [6](modules/investor-activity.md#11-known-limitations) | profile imports a type from this module's repository directory | low | #122 (closed, not done) |  |

#### modules/offering.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/offering.md#11-known-limitations) | The reconfirmation reminders do not stop while the disclosure pack is outdated, although reconfirming then fails; whether to tell investors on a ... | low | #248 |  |
| [2](modules/offering.md#11-known-limitations) | The 90% funding tolerance and the fact that the credited amount is not recorded on the money event are open | medium | #172 |  |
| [3](modules/offering.md#11-known-limitations) | A late or unmatched payment edge case (a second success on an already funded reservation) is open; decision AD-288 | medium | #168 |  |
| [4](modules/offering.md#11-known-limitations) | The Coinbase onramp webhook has not been exercised by a real signed delivery; the JSON key names are assumed | medium | #173 |  |
| [5](modules/offering.md#11-known-limitations) | The funding rail stays closed until a human completes the pre-launch checklist per environment | low | #7 |  |
| [6](modules/offering.md#11-known-limitations) | Offering media URLs are only checked for HTTPS and URL shape; credentials and control characters in a URL are accepted and the original text is stored | low | #218 |  |
| [7](modules/offering.md#11-known-limitations) | One malformed stored media URL makes the whole list or detail fail with 422 | medium | #211, PR #243 |  |
| [8](modules/offering.md#11-known-limitations) | Closing an intake case writes the offering's status and its reservations from intake's repository in one transaction instead of through a job (AD-145 ... | medium | none |  |
| [9](modules/offering.md#11-known-limitations) | README.md and docs/dead-letter-jobs.md say the pre_offering_open_handoff replay "opens the offering anyway"; the consumer does not re-check the case ... | low | #221 |  |
| [10](modules/offering.md#11-known-limitations) | Reservation creation does a Coinbase call outside the database transaction after the hold exists; a Coinbase 4xx leaves a purchase_failed hold that ... | low | PR #244 |  |
| [11](modules/offering.md#11-known-limitations) | The window-opened mail and its audit row are two steps; a retry after a failed audit write sends the email again | low | none |  |
| [12](modules/offering.md#11-known-limitations) | PrismaOfferingRepository is 1991 lines and holds every offering interface | low | #181, PR #237 |  |
| [13](modules/offering.md#11-known-limitations) | A response that fails its schema surfaces as 422 validation.invalid_field with internal field paths and is not logged | medium | #244, #245 | L-14 |
| [14](modules/offering.md#11-known-limitations) | The module imports the repository types of identity and nothing else, but intake and profile read its tables or copy its rules; the architecture ... | low | #122 (closed, not done) |  |
| [15](modules/offering.md#11-known-limitations) | The shared idempotency middleware looks a key up by (Idempotency-Key, endpoint) only, where endpoint is the fixed name given at mount ... | medium | #122 (closed, not done) | L-4 |
| [16](modules/offering.md#11-known-limitations) | The middleware has no claim step: it reads, runs the handler, then saves | medium | #122 (closed, not done) | L-5 |
| [17](modules/offering.md#11-known-limitations) | Disclosure uploads are read into memory in full (limit 100 MB) before the scan, with no cap on concurrent uploads | medium | none | L-16 |
| [18](modules/offering.md#11-known-limitations) | The scanner call is wrapped in a binding-less catch that throws a fixed 503 offering.document_scanner_unavailable without the cause and without a ... | medium | #247 | L-3 |

#### modules/profile.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/profile.md#11-known-limitations) | The existing guide says the response does not include notification preferences and that investment_eligible requires "both Google and email/password ... | low | none |  |
| [2](modules/profile.md#11-known-limitations) | The investing rule is duplicated between GetProfileService and the offering policy; nothing ties the two together except a comment | low | none |  |
| [3](modules/profile.md#11-known-limitations) | Preference changes are not audited, and the route has no fresh-authentication requirement | low | none |  |
| [4](modules/profile.md#11-known-limitations) | The module imports four other modules' repository types | low | #122 (closed, not done) |  |
| [5](modules/profile.md#11-known-limitations) | readiness.payment_account_ready and wallet.status count a pending wallet claim, while the offering detail reports payment_account_ready and ... | medium | none |  |
| [6](modules/profile.md#11-known-limitations) | PATCH response and GET response are checked with schema.parse; a response that fails the schema surfaces as 422 validation.invalid_field with ... | medium | #244 | L-14 |

#### modules/rental.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/rental.md#11-known-limitations) | The three deductions are hardcoded to 0.00, so every distribution equals the gross rent | low | none |  |
| [2](modules/rental.md#11-known-limitations) | No code, route or command writes rental.rent_collections; the sweep's work list is empty unless a row is inserted by hand | low | none |  |
| [3](modules/rental.md#11-known-limitations) | Holders without a wallet are skipped and only reported in a result field that the sweep drops; what happens to their share later is undecided in the ... | low | none |  |
| [4](modules/rental.md#11-known-limitations) | A reservation-flow position never reaches active on main, so it never receives a distribution; only escrow-minted positions do | low | none |  |
| [5](modules/rental.md#11-known-limitations) | listRentCollectionsAwaitingDistribution reads every undistributed collection with no limit, and one failing calculation stops the run (no ... | low | none |  |
| [6](modules/rental.md#11-known-limitations) | The check-then-insert in the calculation is not atomic: two concurrent runs for one period both pass the existence check and the second insert fails ... | low | none |  |
| [7](modules/rental.md#11-known-limitations) | The two settlement distribution tables have no amount or status check constraint; migration 20261018131001_money_ledger_amount_and_status_checks ... | low | none |  |
| [8](modules/rental.md#11-known-limitations) | No unit or integration test covers the services or the repository | low | none |  |

#### modules/settlement.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/settlement.md#11-known-limitations) | A finalizer run that had campaign errors is logged at error level and completes, so pg-boss does not retry it or dead-letter it; the next hourly run ... | medium | #206, PR #235 |  |
| [2](modules/settlement.md#11-known-limitations) | The mint log search has no upper block and, without a recorded start block, starts at block 0; on a long-lived chain the query grows without bound | medium | #219 |  |
| [3](modules/settlement.md#11-known-limitations) | The finalizer reads campaignOf for every PIV that has a token and a passed deadline on every hourly run, swept campaigns included; the swept check ... | low | none |  |
| [4](modules/settlement.md#11-known-limitations) | A campaign swept by someone else (withdrawRaised is permissionless) before the mints leaves the unminted contributors unminted; the code comment ... | medium | none |  |
| [5](modules/settlement.md#11-known-limitations) | The campaign job keeps no transaction hash between attempts: if the receipt wait gives up while the transaction is pending, a retry reads not_opened ... | medium | none |  |
| [6](modules/settlement.md#11-known-limitations) | The campaign job is not limited to a testnet, while the command is | medium | #176 |  |
| [7](modules/settlement.md#11-known-limitations) | One treasury address, PIV_TREASURY_ADDRESS, is used for every campaign | low | C-008 |  |
| [8](modules/settlement.md#11-known-limitations) | An intent with a recorded hash, no receipt and no pinned nonce is never replaced automatically; the manual repair authority is open | medium | #207 |  |
| [9](modules/settlement.md#11-known-limitations) | The evidence re-check drops the error and only counts it; a plain database error is swallowed the same way | low | none |  |
| [10](modules/settlement.md#11-known-limitations) | The operator-key lock holds one database transaction, and so one pooled connection, for the whole chain send, up to the wait plus hold limits (60 s ... | low | none |  |
| [11](modules/settlement.md#11-known-limitations) | Alerts are log events only; no delivery | low | #150 (closed) |  |
| [12](modules/settlement.md#11-known-limitations) | Neither compose file sets stop_grace_period, so Docker's default applies when the worker is stopped while a chain write is in flight; a pg-boss retry ... | medium | none | L-11 |
| [13](modules/settlement.md#11-known-limitations) | A position's unit count is its cost basis in EUR (costBasisToUnitCount returns its argument): there is no total-supply or price-per-unit model in the ... | low | none |  |

#### modules/wallet.md section 11

| Item | Summary | Risk | Issue / PR | Same as |
| --- | --- | --- | --- | --- |
| [1](modules/wallet.md#11-known-limitations) | GET /balance has no error handling and no time budget: a chain failure is 500, and the capital read can wait on the transport's default retries | medium | #155, PR #239 |  |
| [2](modules/wallet.md#11-known-limitations) | GET /balance reads the account's row without checking that the registration is confirmed, so it answers for a pending claim; the transfer route ... | low | none |  |
| [3](modules/wallet.md#11-known-limitations) | The reconcile route is not mounted when the chain settings or the registry address are missing, so the call is a 404 from the not-found handler; the ... | low | none |  |
| [4](modules/wallet.md#11-known-limitations) | The customer-context check answers a wallet caller with the text "Investor profiles are available only to customer accounts." The same helper is ... | low | none |  |
| [5](modules/wallet.md#11-known-limitations) | The wallet module imports the repository types of identity and settlement, and src/infrastructure imports the module's application types | low | #122 (closed, not done) |  |
| [6](modules/wallet.md#11-known-limitations) | Alerts for a stuck claim or an unhealthy watcher are structured log events only; nothing delivers them to a person | low | #150 (closed) |  |
| [7](modules/wallet.md#11-known-limitations) | docs/wallet-registration-operations.md says a mismatch reminder repeats "until the claim is confirmed or replaced" and omits expiry, which also ends ... | low | #223 |  |
| [8](modules/wallet.md#11-known-limitations) | A response that fails its schema surfaces as 422 validation.invalid_field with internal field paths and is not logged | medium | #244, #245 | L-14 |

## 5. Gaps between the code and the design record

Where the code and the design record disagree, the chapters state both sides, name the conflict register entry or the decision number, and change neither. The register entries named below were read from the design repository's `origin/main` at `eadf224` (2026-11-18); a local checkout of that repository that is behind it shows fewer entries. This documentation edits neither the record nor the register.

[security.md section 20](security.md#20-conflicts-with-the-design-record) is the cross-cutting table; the others are per chapter. "Items" is the number of table rows and list items under the heading; "none found" is the chapter's own statement.

| Chapter | Items | Register entries named |
| --- | --- | --- |
| [architecture.md](architecture.md#13-known-gaps) | 9 | C-001, C-008, C-012, C-015, C-024 |
| [authentication.md](authentication.md#known-gaps-against-the-design-record) | 10 | C-008, C-009, C-010, C-012, C-013, C-024 |
| [staff-access.md](staff-access.md#10-known-gaps-against-the-design-record) | 7 | C-001, C-013, C-024 |
| [api/README.md](api/README.md#131-where-the-code-and-the-design-record-differ) | 8 | C-001, C-006, C-010, C-015, C-018, C-024 |
| [api/platform.md](api/platform.md#known-gaps) | 4 | C-001, C-005, C-015, C-024 |
| [api/intake-customer.md](api/intake-customer.md#known-gaps-against-the-design-record) | 8 | C-001, C-006, C-007, C-008 |
| [api/intake-staff.md](api/intake-staff.md#21-known-gaps-against-the-design-record) | 14 | C-001, C-006, C-014, C-018, C-024 |
| [api/offering.md](api/offering.md#12-known-gaps-between-the-code-and-the-design-record) | 9 | C-001, C-006, C-007, C-008, C-014, C-015, C-016, C-023, C-024 |
| [api/wallet.md](api/wallet.md#8-known-gaps-between-the-code-and-the-design-record) | 5 | C-008, C-009, C-010, C-011 |
| [data-model.md](data-model.md#9-known-gaps-against-the-design-record) | 17 | C-006, C-007, C-008, C-010, C-012, C-014, C-016, C-017, C-018, C-023, C-024 |
| [jobs-and-workers.md](jobs-and-workers.md#9-known-gaps-against-the-design-record) | 19 | C-001, C-006, C-007, C-008 |
| [integrations.md](integrations.md#19-known-gaps-against-the-design-record) | 5 | C-007, C-008 |
| [security.md](security.md#20-conflicts-with-the-design-record) | 11 | C-001, C-006, C-008, C-010, C-013, C-014, C-015, C-024 |
| [modules/account.md](modules/account.md#12-known-gaps-between-the-code-and-the-design-record) | 2 | C-006, C-024 |
| [modules/auth.md](modules/auth.md#12-known-gaps-between-the-code-and-the-design-record) | 4 | C-009, C-012, C-013 |
| [modules/health.md](modules/health.md#12-known-gaps-between-the-code-and-the-design-record) | none found | none |
| [modules/identity.md](modules/identity.md#12-known-gaps-between-the-code-and-the-design-record) | 2 | C-005 |
| [modules/intake.md](modules/intake.md#12-known-gaps-between-the-code-and-the-design-record) | 3 | C-009, C-014, C-018 |
| [modules/investor-activity.md](modules/investor-activity.md#12-known-gaps-between-the-code-and-the-design-record) | 1 | C-007 |
| [modules/offering.md](modules/offering.md#12-known-gaps-between-the-code-and-the-design-record) | 8 | C-006, C-007, C-009, C-014, C-015, C-016, C-018, C-021, C-023 |
| [modules/profile.md](modules/profile.md#12-known-gaps-between-the-code-and-the-design-record) | none found | none |
| [modules/rental.md](modules/rental.md#12-known-gaps-between-the-code-and-the-design-record) | 4 | C-009, C-018, C-022 |
| [modules/settlement.md](modules/settlement.md#12-known-gaps-between-the-code-and-the-design-record) | 6 | C-007, C-008, C-009, C-018, C-019, C-020, C-024 |
| [modules/wallet.md](modules/wallet.md#12-known-gaps-between-the-code-and-the-design-record) | 4 | C-009, C-010, C-011 |

## 6. Decisions awaiting the founder

These are decisions that the chapters record as open or leave to the founder or to the owner of the design record. The chapters do not decide them, and neither does this page. "Chapters" gives the place where the chapter states the question.

| # | Question | What the code does meanwhile | Tracker | Chapters |
| --- | --- | --- | --- | --- |
| 1 | What happens when the rate-limit store is unavailable: let requests through, or refuse them | Lets requests through, logs a warning, and never reconnects; with no store configured no limiter exists | #175 (label `needs-founder-decision`) | [security.md](security.md#19-known-limitations) L-7, [integrations.md](integrations.md), [api/auth-staff.md](api/auth-staff.md#known-limitations), [staff-access.md](staff-access.md#known-limitations) |
| 2 | Whether the automatic job `settlement.open_ipo_escrow_campaign` is limited to a testnet, as the operator command is | Not limited; it runs wherever the settlement bundle is configured | #176 | [modules/settlement.md](modules/settlement.md#11-known-limitations), [api/offering.md](api/offering.md#13-known-limitations-of-the-code), [jobs-and-workers.md](jobs-and-workers.md) |
| 3 | The 90 percent funding tolerance of the onramp recorder and whether the credited amount is recorded on the money event | A constant 90 percent; the credited amount is recorded only for a funded outcome | #172 | [modules/offering.md](modules/offering.md#11-known-limitations), [api/offering.md](api/offering.md#13-known-limitations-of-the-code) |
| 4 | Whether signing requests replace the five-minute fresh-authentication window on money routes, and the route path of signing requests | The window gates those routes; no route uses a signing request; the routes are not mounted | C-012 | [authentication.md](authentication.md#known-gaps-against-the-design-record), [architecture.md](architecture.md#13-known-gaps) |
| 5 | The fresh-authentication window (5 minutes in code, 15 in four places of the record) and whether linking a login method needs fresh authentication | 5 minutes; unlinking is covered, linking is not | C-010 (window); linking is in no register entry found | [security.md](security.md#20-conflicts-with-the-design-record), [api/better-auth.md](api/better-auth.md#known-limitations) |
| 6 | Idempotency: whether the account is part of the key, and how long a stored response lives | The key is `(Idempotency-Key, endpoint)`; the expiry is stored and never read | C-006; PR #244 changes the scope | [security.md](security.md#20-conflicts-with-the-design-record), [api/README.md](api/README.md#131-where-the-code-and-the-design-record-differ), [jobs-and-workers.md](jobs-and-workers.md#9-known-gaps-against-the-design-record) |
| 7 | One treasury address per campaign or per property vehicle | One `PIV_TREASURY_ADDRESS` for every campaign | C-008, question 3 | [modules/settlement.md](modules/settlement.md#11-known-limitations) |
| 8 | Scope of the tightened rate-limit tier; the shape of the rate-limit key; the host in the error `type` URI; the name of the staff origination route; the automatic audit wrapper of AD-148 | Tightened tier on authentication surfaces only; key `rate_limit_hint:<tier>:<subject>`; `https://api.vistablox.io/errors/<code>`; `POST /internal/v1/intake-cases`; each repository writes its own audit rows | none of them has a register entry | [api/README.md](api/README.md#131-where-the-code-and-the-design-record-differ), [security.md](security.md#20-conflicts-with-the-design-record) |
| 9 | Whether the wallet balance route answers for a pending claim | It does; transfer preparation does not | AD-282, item 1 of its "Not decided here", on the record's branch `docs/impact-dead-letter-media-mint-nonce` | [api/wallet.md](api/wallet.md#9-known-limitations-of-the-code) |
| 10 | Retention of the two money evidence tables and of expired wallet claims | No purge; nothing is deleted | none | [data-model.md](data-model.md#10-known-limitations) item L15 |
| 11 | The pre-launch check that Coinbase supports EUR and Base for the account, before the funding rail is opened per environment | The rail is closed by default | #7 | [modules/offering.md](modules/offering.md#11-known-limitations), [investor-offering.md](investor-offering.md) |
| 12 | Decisions D1 to D5 that block the umbrella issue #122 (idempotency, pre-mint claim, queue serialization, dependency rules, exact money) | #122 is closed on GitHub; the chapters list its idempotency and dependency-rule workstreams as not done. #123 (open, label `needs-founder-decision`) holds the decisions; the chapters name #122 only, and #123 was read on the issue tracker for this page | #123 | [modules/account.md](modules/account.md#11-known-limitations), [modules/offering.md](modules/offering.md#11-known-limitations), [data-model.md](data-model.md#10-known-limitations) |

## 7. What has not been verified

Every chapter ends with its own "Not verified" section; those are the authority. The items below recur across chapters.

| Not verified | Why | Chapters |
| --- | --- | --- |
| The contents of the staging host file `.env.staging` and any production configuration | Neither is in the repository. Statements about what reaches a container state what `docker-compose.staging.yml` passes, not what is deployed. | [configuration.md](configuration.md#9-not-verified), [operations.md](operations.md#16-not-verified), [security.md](security.md#21-not-verified), [api/README.md](api/README.md#133-not-verified) |
| Behaviour on PostgreSQL 18 | The local checks ran on PostgreSQL 16.15. | [data-model.md](data-model.md#11-not-verified), [testing.md](testing.md#10-not-verified), [modules/health.md](modules/health.md#13-not-verified) |
| Real Coinbase behaviour: the webhook header and body key names, and EUR and Base support | No signed delivery was available; the key names are assumed (issue #173). | [api/offering.md](api/offering.md#14-not-verified), [modules/offering.md](modules/offering.md#13-not-verified) |
| Real clamd 1.4.6: that it answers `UNKNOWN COMMAND` to the command the scanner sends on main | Taken from the description of #225; only the literal backslash and zero in the source was read directly. | [api/README.md](api/README.md#133-not-verified), [integrations.md](integrations.md#21-not-verified), [operations.md](operations.md#16-not-verified) |
| Better Auth beyond the installed 1.7.2 sources; authenticated outcomes of `/api/auth` endpoints (links, revocation, passkey ceremonies) | Read from the library and the repository code; anonymous behaviour was observed on an instance built outside the repository. | [api/better-auth.md](api/better-auth.md#not-verified), [authentication.md](authentication.md#not-verified), [api/auth-customer.md](api/auth-customer.md#not-verified) |
| Citations that point into `node_modules` (Better Auth, its passkey plugin, nodemailer, pg-boss) | Those files are not in the repository; a reader needs `npm ci` to follow them. | [api/auth-staff.md](api/auth-staff.md#not-verified), [jobs-and-workers.md](jobs-and-workers.md#12-not-verified) |
| The mobile app: what it sends, and whether section 3 of the mobile plan is byte-identical with section 3 of `docs/plans/device-bound-auth-backend.md` | The mobile repository was not available. | [authentication.md](authentication.md#not-verified), [security.md](security.md#21-not-verified) |
| Host and platform: the host firewall, the reverse proxy, the Docker stop timeout and restart behaviour after a reboot | Outside the repository. | [operations.md](operations.md#16-not-verified), [jobs-and-workers.md](jobs-and-workers.md#12-not-verified) |
| Timing statements (start delay of a cron job, behaviour after a killed container, two workers) | Derived from library code, not measured. | [jobs-and-workers.md](jobs-and-workers.md#12-not-verified) |
| Defects marked "by reading" or "derived" | Read from the code or the library and not reproduced. | The `Not verified` section of the chapter that states the defect |
| The size and content of the runtime image, and the `npm audit` counts | The image was not built; the counts come from an earlier run and were not reproduced. | [security.md](security.md#21-not-verified), [operations.md](operations.md#16-not-verified) |
| The behaviour of the open pull requests | The `Pending` lines come from reading each pull request's head. Nothing was merged, checked out or run. | [api/offering.md](api/offering.md#14-not-verified), [jobs-and-workers.md](jobs-and-workers.md#12-not-verified) |
| The design record at `origin/main` (`eadf224`) is taken as "the record" | A local checkout of the design repository sits on an older branch. | [data-model.md](data-model.md#11-not-verified), [configuration.md](configuration.md#9-not-verified) |

## 8. How to update this page after a merge

When a pull request listed in section 3 merges, or when main moves for any other reason, update in this order.

1. Find its lines: `grep -rn "Pending #N" docs`, with `N` the pull request number.
2. For each line, make the statement above it true of the new main: change the text, replace the citations (`path:line`, with the identifier), and delete the `> Pending #N:` line. If the pull request closes a limitation, delete that item from the chapter's "Known limitations" section in the same edit.
3. Re-check every citation in a chapter you touched against the new main. A pull request that moves code (#237 moves the mounts out of `src/app.ts`) changes line numbers in many chapters even where it carries no line.
4. Change "Valid for main at 48aa967 (2026-11-18)." to the new commit and date in each file you re-checked, and in no other file. A file that was not re-checked keeps its old stamp.
5. In this page: delete the pull request's row from section 3, update the limitation rows in section 4 (remove the closed items, move the risk if it changed), and update sections 2, 5 and 6 where the merge changes them.
6. Check that every relative link and anchor under `docs/` still resolves, and that [README.md](README.md) links every file in `docs/`. The repository has no automated check for this: `.github/workflows/ci.yml` has no documentation step.

A new pull request that changes documented behaviour adds its `> Pending #N:` lines under the statements it changes and a row in section 3, before it is merged.
