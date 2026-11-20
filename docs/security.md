# Security

Valid for main at 48aa967 (2026-11-18).

The inventory of security controls in the VistaBlox API: what each control is, where it sits in the code, what happens when the thing it depends on is absent or down, and which defects were found in it. The readers are the founder, a reviewer who has to say what the API protects and what it does not, and an engineer who changes a control. Sign-in mechanics are in [authentication.md](authentication.md) and staff access in [staff-access.md](staff-access.md); the request path is in [architecture.md](architecture.md).

Citations are `(path:line)` at 48aa967 with the identifier named next to the number. `Not verified:` marks what could not be checked from the repository, with the reason. A line that starts with `> Pending #N:` says what an open pull request changes in the statement above it; nothing under such a line is built on main. Issue numbers are GitHub issues of this repository. Several library behaviours below were read from `node_modules` at the versions locked in `package-lock.json` or observed in scratch processes outside the repository; each says so.

Contents: [1 Inventory](#1-control-inventory) · [2 Authentication and populations](#2-authentication-layers-and-populations) · [3 Rate limiting](#3-rate-limiting) · [4 Idempotency](#4-idempotency) · [5 DPoP](#5-dpop-and-replay-protection) · [6 Origins, CORS, cookies](#6-trusted-origins-cors-and-cookies) · [7 HTTP headers](#7-http-headers) · [8 Body limits](#8-body-size-and-charset-limits) · [9 Validation](#9-input-validation-and-response-validation) · [10 Error disclosure](#10-error-disclosure) · [11 Logging and alerting](#11-logging-redaction-trace-ids-and-alerting) · [12 Audit log](#12-the-audit-log) · [13 Webhooks](#13-webhook-verification) · [14 Uploads](#14-uploads) · [15 Personal data](#15-personal-data-and-retention) · [16 Secrets](#16-secrets-in-configuration) · [17 Self-custody](#17-the-self-custody-boundary) · [18 Dependencies](#18-dependency-posture) · [19 Known limitations](#19-known-limitations) · [20 Record conflicts](#20-conflicts-with-the-design-record) · [21 Not verified](#21-not-verified)

## 1. Control inventory

| # | Control | Protects against | Where | Section |
| --- | --- | --- | --- | --- |
| 1 | Session authentication: Better Auth cookie or signed bearer token | anonymous access | `src/modules/auth/api/shared/require-authentication.ts:47`; `src/modules/auth/infrastructure/shared/better-auth.factory.ts:314` | 2 |
| 2 | Account status gate (`active` only) | use of a restricted or recovering account | `src/modules/auth/api/shared/require-authentication.ts:77-84` | 2 |
| 3 | Populations and staff roles | customers using staff routes, staff roles used out of scope | `src/modules/auth/api/staff/require-staff-role.ts` | 2 |
| 4 | Per-session staff WebAuthn | a stolen staff session cookie | `src/modules/auth/api/staff/require-staff-role.ts:92`; `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:32` | 2 |
| 5 | Partner case assignment | a partner reading cases of other practices | `src/modules/intake/api/require-partner-case-assignment.ts` | 2 |
| 6 | Fresh authentication | sensitive actions on a stale session | `src/modules/auth/domain/fresh-authentication.ts:10` | 2 |
| 7 | DPoP proof of possession and replay table | a stolen bearer token used from another device | `src/modules/auth/application/shared/dpop-proof-verifier.ts` | 5 |
| 8 | Disabled authentication routes | credential, email-code and passkey-deletion endpoints on the wire | `src/modules/auth/domain/disabled-auth-routes.ts` | 2 |
| 9 | Rate limiting, two tiers | scraping, brute force, floods | `src/shared/http/rate-limit.ts` | 3 |
| 10 | `Idempotency-Key` middleware | double execution of three high-risk writes | `src/shared/http/idempotency.ts` | 4 |
| 11 | Trusted origins, CORS, cookie attributes | cross-origin use of a browser session | `src/app.ts:520`; `src/modules/auth/infrastructure/shared/better-auth.factory.ts:453-484` | 6 |
| 12 | `helmet` headers | content sniffing, framing, referrer leaks | `src/app.ts:521` | 7 |
| 13 | Body size and content-type limits | oversized and malformed bodies | `src/app.ts:581`, `:588` | 8 |
| 14 | Zod validation of requests and responses | malformed input, shape drift | each router | 9 |
| 15 | Error envelope with fixed 5xx details | information disclosure | `src/shared/http/error-handler.ts` | 10 |
| 16 | Log redaction, query masking, URL and hex masking | secrets and personal data in logs | `src/infrastructure/logging/`; `src/shared/logging/log-redaction.ts` | 11 |
| 17 | Audit log and append-only ledgers | repudiation, silent change | `audit.audit_log` (no trigger) and five trigger-protected tables | 12 |
| 18 | Webhook signatures (Didit, Coinbase) | forged provider callbacks | `didit-webhook-verifier.ts`; `coinbase-onramp-webhook-verifier.ts` | 13 |
| 19 | Upload allowlist, size cap, malware scan, private storage | hostile files, direct object access | `upload-case-document.service.ts`; `upload-offering-document.service.ts` | 14 |
| 20 | Minimised storage of provider data | personal data at rest | [didit-kyc.md](didit-kyc.md) | 15 |
| 21 | Configuration validation at boot | missing or malformed secrets | `src/config/environment.ts` | 16 |
| 22 | Self-custody boundary | the platform signing for users | `src/infrastructure/blockchain/chain-client.ts` | 17 |
| 23 | Dead-letter alert with masking and a once-only replay guard | silent job loss, secret leakage in alerts | `src/shared/jobs/` | 11 |

## 2. Authentication layers and populations

### 2.1 Populations and sessions

Two populations exist: `customer` and `staff_partner`. The population is a field of the Better Auth user, defaulting to `customer`, and a client cannot set it: the field is declared with `input: options.allowPopulationInput === true`, which is `false` for the instance that is mounted over HTTP (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:164-169`). A second Better Auth instance, `staffProvisioningAuth`, is built with `allowPopulationInput: true`; it is used only in process by the staff invitation service and is never handed to `toNodeHandler` (`src/server.ts:370-380`, `:583`, `:747`).

| | `customer` | `staff_partner` |
| --- | --- | --- |
| How an identity is created | Google or Apple sign-in through Better Auth (`GOOGLE_OAUTH_ENABLED`, `APPLE_OAUTH_ENABLED`), then device-key enrolment. Email and password are off (`emailAndPassword: { enabled: false }`, `src/modules/auth/infrastructure/shared/better-auth.factory.ts:242`). | Invitation only: a 72-hour single-use token whose SHA-256 hash is stored, issued by an `admin_operations` staff member or, for the first admin, by the bootstrap command (`README.md:26`, `src/cli/bootstrap-first-admin.ts`). |
| Login factor | The device key: a biometric-protected key pair enrolled on the phone, checked with Android key attestation and, when configured, Play Integrity. Passkeys are refused for customers. | A WebAuthn passkey (`residentKey: required`, `userVerification: required`, `src/modules/auth/infrastructure/shared/better-auth.factory.ts:354-355`). |
| Session level (`authenticationLevel`) | `oauth_pending` after provider sign-in, `device_biometric` after device login (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:25-30`, `resolveAuthenticationLevel` at `:498-512`). | `staff_passkey` |
| Lifetime | A device session is idle-limited to 5 minutes and ends 30 minutes after creation, with no renewal (`src/modules/auth/domain/device-session-lifetime.ts:10-11`). | Better Auth's session settings: `expiresIn` 30 minutes, `updateAge` 5 minutes (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:194-195`). |
| Roles | none | `admin_operations`, `legal_partner`, `appraisal_partner` (`src/modules/auth/api/staff/require-staff-role.ts`). A partner role is tied to a legal practice or an appraisal firm by the check `staff_role_assignment_scope` on `auth.staff_role_assignments`, which the initial migration created as `account.staff_role_assignments` and a later migration moved to the `auth` schema (`prisma/migrations/20260831150000_initial_schema/migration.sql:930-937`; `prisma/migrations/20260909110000_separate_auth_schema/migration.sql:14`; `prisma/schema/auth.prisma:107-108`). |

A session is carried either by the Better Auth cookie (prefix `vb`, `session_token`) or by `Authorization: Bearer <value.signature>`: the bearer plugin runs with `requireSignature: true`, so a bare session token is refused (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:314`, `:456`).

### 2.2 The layers of one authenticated request

In order, for a route that lists `requireAuthentication` (`src/modules/auth/api/shared/require-authentication.ts:45-128`):

1. The session is resolved from the headers (`sessions.resolve`, `:47`). None: 401 `authentication.required`.
2. If the session is bound to a DPoP key, a fresh, matching, unreplayed proof is mandatory; an unbound session is let through, and a valid proof from a session created before the cutover binds it (`:62-66`, `:158-239`; section 5).
3. The account row is looked up by the Better Auth user id; none: 500 `account.mapping_missing` (`:68-76`).
4. The account status must be `active`; `recovery_review` and `suspended_restricted` are refused with 403 `account.restricted` (`:77-84`).
5. `response.locals.authContext` is set with `accountId`, `providerSessionId`, `population`, `authenticationLevel`, `sessionCreatedAt` and, for a bound session, `dpopJkt` (`:86-95`). This is the only assignment of the context in `src` (grep).
6. The baseline rate limiter runs, keyed by the account (`:114-124`; section 3).
7. Session activity is recorded; a failed write is logged and the request continues (`:102-113`).

Then the route's own guards run in the order the router lists them ([architecture.md](architecture.md) section 5.4).

### 2.3 Guard chains by route family

| Route family | Chain before the handler |
| --- | --- |
| `GET /health/*`, `GET /v1/offerings`, `/.well-known/*` | none; `GET /v1/offerings` runs under the per-IP baseline limiter of the `/v1/offerings` mount (section 3.2) |
| `POST /webhooks/didit`, `POST /webhooks/coinbase-onramp` | signature verification in the handler (section 13); no rate limit |
| `GET /v1/app/config`, `POST /v1/auth/mobile/{enrol,login}/{challenge,verify}` | `requireDpopOnly` (a valid proof from any key, recorded against replay); the four `/v1/auth/mobile` routes also get the tightened limiter and a per-DPoP-key limiter (`src/app.ts:777-790`) |
| `POST /v1/auth/staff-invitations/accept` | tightened limiter, then the single-use token (`src/app.ts:948-952`) |
| `/api/auth/*` | `rejectDisabledAuthRoutes`, tightened limiter, then Better Auth and its plugins |
| Customer routes (`/v1/offerings/:id`, `/v1/kyc`, `/v1/investor-profile/*`, `/v1/auth/account-closure`) | `requireAuthentication`, then the handler's `population === "customer"` check; every route under `/v1/offerings` is also counted by the per-IP baseline limiter of that mount before authentication (section 3.2) |
| Customer routes without that check (`/v1/intake-cases`, `/v1/auth/sessions`, `/v1/auth/login-methods`, `/v1/auth/mobile/replacement`, `/v1/auth/signing-requests`, which is never mounted) | `requireAuthentication` only; every query is filtered by the caller's `accountId` |
| Customer sensitive routes (reservation creation and reconfirmation, login-method unlink, session revocation) | `requireAuthentication`, `requireFreshAuthentication` |
| `/internal/v1/**` (staff) | `requireAuthentication`, `requireAdminOperations`, `requireStaffWebAuthn` |
| `/internal/v1/auth/webauthn/*` | tightened limiter, `requireAuthentication`, `requireStaffIdentity` (any staff role; this is how the WebAuthn proof is obtained) |
| `/internal/v1/{legal,appraisal}-partner/cases` | `requireAuthentication`, partner role, `requireStaffWebAuthn`, `requirePartnerCaseAssignment` |

Sources: `src/app.ts:591-1188`; `src/modules/auth/api/staff/require-staff-role.ts`; the customer population checks are listed in [architecture.md](architecture.md) section 5.4.

### 2.4 Staff step-up

A staff session counts as WebAuthn-verified when its mirrored session row is active with `authMethodAtLogin = 'staff_passkey'`, or when a legacy row exists in `staffSessionMfa` (`src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:32-53`). A challenge lives 5 minutes (`src/modules/auth/application/staff/staff-webauthn.service.ts:10`). The authenticator must verify the user (`userVerification: "required"`, `src/modules/auth/infrastructure/staff/simple-webauthn.ceremony.ts:41`, `:74`), and attestation is requested as `none` (`:33`). Details: [staff-access.md](staff-access.md).

### 2.5 Routes kept off the wire

`rejectDisabledAuthRoutes` judges the raw request target before Better Auth sees it. A path is passed on only if it is canonical (the lower-case base path and segments of unreserved characters, no dot segments, no encoded slash or dot, no trailing slash) and not disabled. Disabled: any path that contains `password`, `/sign-in/email`, `/sign-up/email`, anything under `/email-otp` or `/sign-in/email-otp`, `/passkey/delete-passkey`, and `/expo-authorization-proxy` (`src/modules/auth/domain/disabled-auth-routes.ts:37-52`, `:63-96`; `src/modules/auth/api/shared/reject-disabled-auth.ts:28`). A plugin inside Better Auth applies the same test to the pathname its own router is about to use (`better-auth-disabled-routes.plugin.ts`, mounted first at `src/modules/auth/infrastructure/shared/better-auth.factory.ts:302`). The reason given for the last path is that it signs a caller-chosen value with the session secret, which would defeat the signed-bearer rule.

### 2.6 Limitations of the authentication layer

- Fresh authentication covers `/v1` reservation creation and reconfirmation, login-method unlink, session revocation and, through a probe, replacing a pending wallet claim, and the matching Better Auth endpoints `/unlink-account`, `/revoke-session`, `/revoke-sessions` and `/revoke-other-sessions` (`src/modules/auth/infrastructure/customer/better-auth-fresh-authentication.plugin.ts:12-17`). The Better Auth hook skips staff sessions (`:40-44`, `:71`), so a staff session can call those four endpoints without the window. `/link-social` is not in that list, so linking a login method needs a plain session (account linking is enabled for the trusted provider `google` with `allowDifferentEmails: false`, `src/modules/auth/infrastructure/shared/better-auth.factory.ts:221-236`; not exercised here). The record lists "linking or removing login methods" as sensitive (`SESSION_LIFETIME_AND_REVOCATION.md`, "Sensitive Actions"); the code's window is 5 minutes (`src/modules/auth/domain/fresh-authentication.ts:10`) and the record's is 15.
- The customer population check is a convention in six routers, not a shared guard ([architecture.md](architecture.md) section 5.4). A `staff_partner` session can call the customer routes in the list above; each answers only about the caller's own `accountId`.
- On `/v1/auth/sessions/devices/:jkt/revoke` the cancellation of signing requests is not scoped to the caller (section 19, L-9).

> Pending #234: device revoke cancels only the caller's own signing requests.

## 3. Rate limiting

### 3.1 Tiers and keys

| Tier | Limit | Window | Source |
| --- | --- | --- | --- |
| `baseline` | 300 requests | 60 s | `src/shared/http/rate-limit.ts:17-21` |
| `tightened` | 10 requests | 60 s | `src/shared/http/rate-limit.ts:23-27` |

The window is fixed, not rolling: the first request creates a counter with a time-to-live, later requests only increment it (`src/infrastructure/rate-limit/rate-limit-store.ts:2-7`; `src/infrastructure/rate-limit/redis-rate-limit-store.ts:13-19`). A request over the limit gets 429 `rate_limit.exceeded` with `Retry-After` set to the length of the window, not to the time that remains (`src/shared/http/rate-limit.ts:40-50`). The numbers are a starting point, described in the code as a tuning task (`src/shared/http/rate-limit.ts:14-16`).

The key is `rate_limit_hint:<tier>:<subject>` (`src/shared/http/rate-limit.ts:35`). The subject is `account:<account_id>` when `response.locals.authContext` is set, otherwise `ip:<address>` (`src/shared/http/rate-limit.ts:68-73`); the device-auth routes add a second limiter whose subject is `dpop_jkt:<thumbprint>` (`:129-133`). The address is `request.ip` normalised: an IPv4-mapped IPv6 address becomes its IPv4 form, any other IPv6 address becomes its first four groups and `::/64`, and a value that is not an address (for example a forged `X-Forwarded-For` that Express returns because `TRUST_PROXY` counts too many hops) falls back to the connecting address (`src/shared/http/rate-limit.ts:86-105`).

`TRUST_PROXY` feeds Express's `trust proxy`: a hop count from 0 to 10, a list of addresses, CIDR ranges (IPv4 of /8 or longer, IPv6 of /16 or longer), or `loopback`, `linklocal`, `uniquelocal` (`src/config/environment.ts:183`, `:733-790`). Unset, `request.ip` is the connecting address; behind a proxy every caller then shares one bucket, and the api logs a `warn` at boot when rate limiting is on, `NODE_ENV=production` and the variable is unset (`src/server.ts:206-212`). The staging compose file passes the variable through with an empty default and has no value of its own (`docker-compose.staging.yml:157-166`). Its comment says a hop count is only safe while the published port 3000 is not reachable from outside, and prefers the Docker subnet of the `proxy` network (`docker-compose.staging.yml:157-165`); a hop count larger than the number of proxies that append an address, or a direct connection to the published port, lets a caller choose the entry it is counted under (`src/config/environment.ts:738-743`).

### 3.2 Where each tier is mounted

| Tier | Mount | Keyed by | Source |
| --- | --- | --- | --- |
| baseline | the `/v1/offerings` mount (`app.use("/v1/offerings", baselineRateLimiter, createOfferingRouter(...))`): every method and every path under that prefix, that is the public list, offering detail, reservation creation and reconfirmation and document download, before authentication (the key is `ip:<address>` because `authContext` is not set yet) | IP | `src/app.ts:591-595` |
| baseline | inside `requireAuthentication`, after the session, the DPoP check and the account lookup, so on every authenticated route | account | `src/app.ts:597-602`; `src/modules/auth/api/shared/require-authentication.ts:114-124` |
| tightened | `/api/auth/*splat`, all Better Auth endpoints including reads such as `get-session` | IP | `src/app.ts:568-575` |
| tightened | `/v1/auth/mobile/*` (challenge and verify), together with a per-DPoP-key limiter | IP and key | `src/app.ts:778-790` |
| tightened | `/v1/auth/staff-invitations` (the accept route) | IP | `src/app.ts:948-952` |
| tightened | `/internal/v1/auth/webauthn/*` | IP (it runs before authentication) | `src/app.ts:1045-1053` |
| none | `/health/*`, `/.well-known/*`, `/webhooks/*`, `GET /v1/app/config` | | `src/app.ts:522-590`, `:777` |

The tightened tier has one key space: `rate_limit_hint:tightened:ip:<address>` is shared by the Better Auth mount, the device-auth mount, the invitation accept route and the staff WebAuthn ceremonies. Because the baseline limiter inside `requireAuthentication` sits behind the session check, a flood of requests with an invalid or missing token is answered 401 before that limiter counts it. The "keyed by IP when unauthenticated" behaviour exists only for requests under the `/v1/offerings` prefix, where the mount-level limiter runs first. A request there from an authenticated customer is counted twice, once under `rate_limit_hint:baseline:ip:<address>` at the mount and once under `rate_limit_hint:baseline:account:<account_id>` in `requireAuthentication`; callers that share one address (a mobile carrier's NAT, or every caller when `TRUST_PROXY` is unset behind a proxy) share the 300-per-minute IP bucket for all of those routes. Reproduced with the repository's `createRateLimiter` and a stand-in store: four requests under `/v1/offerings` (list, detail, `POST` reservation, `DELETE`) incremented the same IP key four times and the account key twice (`src/app.ts:591-595`, `:642-680`).

Better Auth's own limiter does nothing here: the factory sets `advanced.ipAddress.disableIpTracking: true` (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:455`), and the installed Better Auth 1.7.2 skips rate limiting when it has no client address and that option is set (`node_modules/better-auth/dist/api/rate-limiter/index.mjs`, `resolveRateLimitConfig`; read at the locked version).

### 3.3 When Redis is absent or fails

| State | Result | Source |
| --- | --- | --- |
| `RATE_LIMIT_CACHE_URL` unset | No limiter exists; no log line. | `src/app.ts:467-481`; `src/server.ts:142-148` |
| Set but unreachable at boot | A `warn` and no limiter, until the process restarts. | `src/server.ts:152-158` |
| Connected at boot, then the connection drops | The client has `reconnectStrategy: false`, so the store throws on every call; the middleware logs a `warn` and lets the request through. | `src/server.ts:147`; `src/infrastructure/rate-limit/redis-rate-limit-store.ts:13`; `src/shared/http/rate-limit.ts:54-62` |

The staging compose file defines no Redis or Valkey service and its `&app-environment` anchor does not pass `RATE_LIMIT_CACHE_URL` (`docker-compose.staging.yml`; grep). Whether staging or production meter anything depends on `.env.staging` or the production configuration. Not verified: those files. The policy for an unavailable store is an open founder decision (issue #175).

### 3.4 Limitations

- Fail open on every store error, and no reconnect (issue #175).
- `INCR` and `EXPIRE` are two calls: the expiry is set only when the count is 1 (`src/infrastructure/rate-limit/redis-rate-limit-store.ts:14-17`). If the second call fails after the first succeeded, the key has no time-to-live and the counter is never reset; every later request counts toward the limit until the key is removed. Derived from reading; not reproduced.
- The record puts money-movement actions and `Idempotency-Key` writes in the tightened tier (`RATE_LIMITING.md`, "Threshold Tiers"; AD-129, AD-176). The code gives reservation creation, reconfirmation, finalization, wallet registration, transfer preparation and account closure only the baseline limit (300 per minute per account). No conflict register entry was found.
- `GET /v1/app/config` runs `requireDpopOnly`, which inserts a row into `auth.dpop_replays` per request, and has no limiter (`src/app.ts:777`; `src/modules/auth/api/customer/require-dpop-only.ts:67-72`).
- Staff-only routes that send an email per call (`send-reminder`, staff invitation issue, staff recovery) have no cooldown beyond the baseline limit.

## 4. Idempotency

### 4.1 What is built

`createIdempotencyMiddleware(store, endpoint)` guards three routes, each with its own stable endpoint identifier (`src/app.ts:490-501`):

| Route | `endpoint` |
| --- | --- |
| `POST /v1/offerings/:offering_id/reservations` | `offering.reservation.create` |
| `POST /v1/offerings/:offering_id/reservations/:reservation_id/reconfirm` | `offering.reservation.reconfirm` |
| `POST /internal/v1/offerings/:offering_id/finalize` | `offering.finalize` |

Rows live in `audit.idempotency_keys` with the primary key `(idempotency_key, endpoint)` and the columns `request_body_hash`, `response_status`, `response_body`, `account_id`, `created_at`, `expires_at` (`prisma/schema/schema.prisma:1085-1102`). Flow (`src/shared/http/idempotency.ts:17-95`):

1. The `Idempotency-Key` header must be present and non-blank, otherwise 400 `idempotency.key_required` (`:27`). The middleware sets no length limit; reservation creation additionally requires at most 128 characters in its handler (`src/modules/offering/api/offering.router.ts:68-76`).
2. The body hash is SHA-256 over a key-sorted JSON serialisation of `request.body` (`:36`, `:118-128`). The HTTP method, the URL path, the path parameters and the account are not part of it.
3. The store is read with `(key, endpoint)`. A failure to read answers 503 `idempotency.store_unavailable` and the handler does not run (fail closed, `:45-52`).
4. No row: the handler runs; `response.json` is wrapped so that the response is saved before it is sent. A status of 500 or more is not saved, so a retry with the same key runs the handler again (`:64`, #200). 2xx and 4xx responses are saved. A failure to save is logged at `warn` and the response is still sent (fail open, `:97-110`).
5. A row with the same body hash: the stored status and body are sent without running the handler (`:91`). A row with another hash: 409 `idempotency.body_mismatch` (`:84`).

Retention is recorded, not enforced: `expires_at` is set to 48 hours after creation (`:11`, `:75`), but the store's `find` is `findUnique` on the key and ignores `expires_at`, and no job deletes expired rows (`src/infrastructure/idempotency/prisma-idempotency-store.ts:12-14`; there is no `idempotencyKey` delete in `src`, and the only maintenance jobs are listed in section 15). A stored response therefore replays for as long as the row exists.

Reservation creation is protected a second time by its own `client_idempotency_key` column (`src/modules/offering/application/create-reservation.service.ts:73`, `:128`; conflict register C-006). The four intake reversal commands read `Idempotency-Key` by hand and store it in their own table, not in `audit.idempotency_keys` (`src/modules/intake/api/intake-operations.router.ts:202-206`).

> Pending #244: idempotency keys are scoped to the account plus the path identifiers, and a fourth guarded route, `POST /v1/offerings/:offering_id/reservations/:reservation_id/payment-session`, is added.

### 4.2 Reproduced behaviour

The repository's `idempotency.ts` and `error-handler.ts` were run unchanged in a scratch Express app with an in-memory store that mimics `PrismaIdempotencyStore` (a unique-key conflict returns the winning row). The real store and a database were not used. Results:

| Case | Observed |
| --- | --- |
| Two concurrent requests, same key, same body | both ran the handler (`runs = 2`) and each got its own response; `save` returned the winner on the conflict but the loser still answered with its own body (`src/shared/http/idempotency.ts:97-110` ignores the saved row) |
| Same key, same body, sequential | the stored response was replayed, the handler did not run |
| Same key, same body, another account, same endpoint | the first account's response (its reservation) was replayed to the second account; the second handler never ran |
| Same key, same body, another `:offering_id` in the path | the first offering's response was replayed |
| Same key, different body | 409 `idempotency.body_mismatch` |
| No key | 400 `idempotency.key_required` |

The first row is the concurrent-request gap: the guarantee in AD-147 that a replay returns the stored response without running the handler again holds after the first response is stored, and during the window before that only the handlers' own checks protect the write (the reservation's `client_idempotency_key`, row locks, stage checks). The third and fourth rows follow from the key shape `(key, endpoint)` that `CORE_TABLES.md` and AD-147 also use, so the gap is in the record as well as in the code; conflict register entry C-006 (item 3) records the replay across accounts and across offerings from a reading of the code, and this pass reproduced it. It needs a key collision between callers: a client that derives its keys deterministically (for example from the offering and the amount) can hit it; random keys cannot in practice. Not verified: the mobile client's key scheme (`vistablox-mobile` is not in this checkout).

## 5. DPoP and replay protection

### 5.1 The proof

A DPoP proof is a JWT in the `DPoP` header (`src/modules/auth/application/shared/dpop-proof-verifier.ts:121-208`, `verifyDpopProof`):

| Check | Rule | Line |
| --- | --- | --- |
| Header | `typ` is `dpop+jwt`, `alg` is `ES256`, an embedded `jwk` that is a public EC P-256 key (`kty`, `crv`, `x`, `y`, no `d`) | `:154-173` |
| Signature | verified against the embedded key with `jose` (`EmbeddedJWK`, algorithms `["ES256"]`) | `:177` |
| `htm` | equals the request method in upper case | `:183` |
| `htu` | equals scheme, lower-case host and path of `BETTER_AUTH_URL` plus the request path as sent, without query or fragment; never built from request headers | `:102-111`, `:186` |
| `iat` | within 60 seconds of the server clock, either direction | `:5`, `:191` |
| `jti` | `^[A-Za-z0-9_-]{16,64}$` | `:9`, `:194` |
| `ath` | when a bearer token is sent, the base64url SHA-256 of the exact characters after `Bearer ` | `:197-204` |

The key thumbprint (`jkt`, RFC 7638 SHA-256) identifies the key. A `(jkt, jti)` pair is inserted into `auth.dpop_replays` with `ON CONFLICT DO NOTHING`; an existing pair is a replay (`src/modules/auth/repository/shared/prisma-dpop-replay.repository.ts:7-19`). The row lives for 120 seconds by default (`src/modules/auth/api/shared/require-authentication.ts:242`) and the hourly job `maintenance.dpop_replay_prune` deletes expired rows (`src/worker.ts:549`, `:784-789`; `src/modules/auth/repository/shared/prisma-dpop-replay.repository.ts:21-26`). Failures are 401 with `WWW-Authenticate: DPoP error="invalid_dpop_proof"` and a code from `DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID`, `DPOP_REPLAY`, `DPOP_KEY_MISMATCH` (`src/modules/auth/application/shared/dpop-proof-verifier.ts:11-41`, `:64`).

### 5.2 Where it is enforced

| Door | Behaviour | Source |
| --- | --- | --- |
| `/v1` routes through `requireAuthentication` | A session bound to a key (`dpopJkt` set) must present a matching proof, with `ath` when a bearer token is sent. Without DPoP wiring a bound session is refused (`DpopProofMissingError`). An unbound session is not required to present one. | `src/modules/auth/api/shared/require-authentication.ts:62-66`, `:158-193` |
| An unbound session that presents a valid proof | Bound to that key if the session was created before `DPOP_PHASE1_CUTOVER_AT` or the cutover is unset; refused with `DPOP_KEY_MISMATCH` if it was created after. An unverifiable or replayed proof is ignored. | `:203-239`, `:228-232` |
| `/api/auth/*` | A before-hook applies the same decision to Better Auth calls, except the passkey and device verification ceremonies, which enforce inline. | `src/modules/auth/infrastructure/shared/better-auth-dpop.plugin.ts`; `dpop-session-creation.ts` |
| Device-auth routes without a session | `requireDpopOnly`: a valid proof from any key, recorded unless the route runs the ceremony that records it itself (`recordReplays: false` for `/enrol/verify` and `/login/verify`). It never checks `ath`. | `src/modules/auth/api/customer/require-dpop-only.ts:51-96`; `src/app.ts:755-776` |
| Session creation by device login | The new session is bound to the proof's key at creation. | `src/modules/auth/infrastructure/shared/better-auth.factory.ts:271`; `src/modules/auth/infrastructure/shared/dpop-session-creation.ts:109` (`tryBindDpopAtCreation`) |

The consequences of the phase-1 policy, read from the code: a session that was never bound works with a bearer token alone; with `DPOP_PHASE1_CUTOVER_AT` unset every unbound session is treated as pre-cutover (`src/modules/auth/api/shared/require-authentication.ts:228-229`, the variable is optional at `src/config/environment.ts:25`). Staff cookie sessions are unbound and carry no DPoP requirement.

The device challenge has its own replay rule on the database clock: a challenge consumed less than 120 seconds ago answers `DEVICE_CHALLENGE_REPLAYED`, and a device row is inserted only if its challenge was consumed less than 60 seconds before (`src/modules/auth/domain/device-challenge-replay.ts:39-40`, `CHALLENGE_REPLAY_WINDOW_MS`, `ENROLMENT_INSERT_DEADLINE_MS`).

## 6. Trusted origins, CORS and cookies

### 6.1 One list, three uses

`AUTH_TRUSTED_ORIGINS` is a comma-separated list that defaults to `http://localhost:3000` and has no production refinement (`src/config/environment.ts:135-138`). `src/server.ts` extends it (`:224-230`): outside `NODE_ENV=production` it adds `exp://`, `exp://**` and `exp://192.168.*.*:*/**` for the Expo dev client, and with `APPLE_OAUTH_ENABLED` it adds `https://appleid.apple.com`. The result is used twice: as Better Auth's `trustedOrigins` (`src/server.ts:314`) and as the CORS allow-list (`corsOrigins`, `src/server.ts:582`). The native app's custom URI scheme is meant to be in the list too (`README.md:16`).

WebAuthn origins are a separate list: `WEBAUTHN_ORIGIN` (exact `https://host[:port]` entries, https only and no loopback when `NODE_ENV=production`) and `WEBAUTHN_RP_ID` (`src/config/environment.ts:35-60`, refinements at `:611-628` and `:629-646`). Origins other than the relying party's own host are published at `GET /.well-known/webauthn`, with `Access-Control-Allow-Origin: *`, no credentials and `Cross-Origin-Resource-Policy: cross-origin` (`src/app.ts:558-567`).

### 6.2 CORS

`cors({ origin: corsOrigins, credentials: true })` runs for every request (`src/app.ts:520`). The `cors` package compares each list entry with the request's `Origin` as a string. `cors` 2.8.5 was run in a scratch process with the repository's call: a request from a listed origin gets `Access-Control-Allow-Origin` with that origin, `Vary: Origin` and `Access-Control-Allow-Credentials: true`; a preflight from an unlisted origin gets 204 with `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE` and no `Access-Control-Allow-Origin`. CORS therefore stops a browser from reading a response; it does not stop the server from running the request. A wildcard entry such as `exp://**` is not interpreted by `cors`; it only has meaning inside Better Auth.

### 6.3 Server-side origin check

Better Auth checks origins itself, for `/api/auth/*` only. In the installed 1.7.2, a request that is not `GET`, `HEAD` or `OPTIONS` and carries a `cookie` header must have an `Origin` (or `Referer`) that matches `trustedOrigins`, and `callbackURL`, `redirectTo`, `errorCallbackURL` and `newUserCallbackURL` must be trusted too; a request without a cookie header is not origin-checked (`node_modules/better-auth/dist/api/middlewares/origin-check.mjs`, `validateOrigin`; read at the locked version). The `/v1` and `/internal/v1` routes have no origin check and no CSRF token: the only `csrf` string in `src` is a log redaction path (`src/infrastructure/logging/logger.ts:11`).

### 6.4 Cookies

| Attribute | Value | Source |
| --- | --- | --- |
| Name | prefix `vb`, cookie `session_token` (the name is not overridden, because the Expo client recognises cookies by `session_token`) | `src/modules/auth/infrastructure/shared/better-auth.factory.ts:456`, `:470-476` |
| `HttpOnly` | true | `:478` |
| `Secure` | true when `NODE_ENV=production`, which includes staging | `:457`, `:479`; `src/server.ts:313` |
| `SameSite` | `Lax` | `:480` |
| `Path` | `/` | `:481` |
| `Domain` | set to the parent domain when `BETTER_AUTH_URL`'s host has three or more labels (for `api.vistablox.io`, `.vistablox.io`), so that the admin console on a sibling subdomain reads the same session; unset for `localhost` | `src/modules/auth/infrastructure/shared/better-auth.factory.ts:129-133`, `:461-466` |
| Client IP | not tracked (`disableIpTracking: true`) | `:455` |

A cookie with a parent `Domain` is sent to every host under that domain. With `SameSite=Lax` and no CSRF token, the defence of cookie sessions against a forged request is the cookie attribute plus the JSON content type on routes that read a body; a `POST` route that reads no body (for example `POST /v1/auth/account-closure/cancel`, `src/modules/auth/api/customer/account-closure.router.ts:31`) does not need a preflight. Customers use signed bearer tokens and DPoP rather than cookies. This is derived from reading; not exercised.

## 7. HTTP headers

`app.disable("x-powered-by")` and `helmet()` run for every response (`src/app.ts:503`, `:521`). `helmet` 8.1.0 and `express` 5.2.1 were run in a scratch process with the same call order; the response carried:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (sent on every response, including over plain HTTP in development) |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `SAMEORIGIN` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` | `same-origin`, `same-origin` |
| `Origin-Agent-Cluster`, `X-DNS-Prefetch-Control`, `X-Download-Options`, `X-Permitted-Cross-Domain-Policies`, `X-XSS-Protection` | `?1`, `off`, `noopen`, `none`, `0` |
| `ETag` | a weak ETag on JSON bodies (Express default) |
| `Keep-Alive` | `timeout=5`: the code sets no `keepAliveTimeout`, so Node's 5-second default applies (`src/server.ts` and `src/app.ts`; grep) |

Set by routes on top of that:

- `Cache-Control: no-store` on customer and staff JSON that carries personal or financial data, set per handler in 14 of the 28 router files: the KYC, KYC operations, customer session, account recovery, staff account lifecycle, account closure operations, offering, offering operations, investor activity, profile, wallet, wallet operations, partner organisation and intake operations routers (`grep -il cache-control` over `src/modules/**/*.router.ts`). Downloads use `private, no-store` (`src/modules/offering/api/offering.router.ts:121`, `src/modules/offering/api/offering-operations.router.ts:136`, `src/modules/intake/api/intake-operations.router.ts:278`). The `/.well-known` association files use `public, max-age=3600` (`src/app.ts:524`, `:536`, `:561`).
- No `Cache-Control` is set by the other 14 router files, among them the customer intake routes (`src/modules/intake/api/intake.router.ts`), the partner case routes (`src/modules/intake/api/partner-case.router.ts`), the staff account search (`src/modules/account/api/account.router.ts`), the customer account-closure routes, and the device-auth, device-replacement, login-methods and staff WebAuthn routers (`src/modules/auth/api/`). The customer session router sets it on the list route and on the device revoke route, not on the two revoke routes that answer 204 (`src/modules/auth/api/customer/customer-session.router.ts:30`, `:80`).
- Downloads add `X-Content-Type-Options: nosniff` and a `Content-Disposition: attachment` whose filename is reduced to `[A-Za-z0-9._-]`, at most 120 characters (`src/modules/offering/api/offering.router.ts:109-143`).

## 8. Body size and charset limits

| Surface | Limit | Source |
| --- | --- | --- |
| JSON bodies, every route except those below | 1 MB, content type `application/json` only; other content types are not parsed and the handler sees `request.body` as `undefined`; gzip and deflate bodies are inflated; charset must be UTF-compatible (415 `request.unsupported_charset` otherwise) | `src/app.ts:588`; `src/shared/http/body-parser-error.ts` |
| `POST /webhooks/coinbase-onramp` | 256 kb raw, `application/json` only | `src/app.ts:581` |
| `/api/auth/*` | none. Better Auth reads the body itself; the adapter `better-call` 1.4.0 is called without a body size limit (`node_modules/better-call/dist/node.mjs`, `getRequest` without `bodySizeLimit`; read at the locked version), and the only bound is the declared `Content-Length` | `src/app.ts:568-575` |
| Staff document upload (intake case documents, offering disclosure documents) | 100 MB, counted while the stream is read; not an Express body-parser limit because the body is not parsed | `src/modules/intake/application/upload-case-document.service.ts:11`, `:102`; `src/modules/offering/application/upload-offering-document.service.ts:11`, `:83` |
| Request line and headers, request time | Node's defaults: `maxHeaderSize` 16384 bytes, `headersTimeout` 60 s, `requestTimeout` 300 s, `keepAliveTimeout` 5 s (read from `http.createServer()` on Node 22.23.4 in the scratch environment; the runtime image is `node:22-alpine`, `Dockerfile:31`; the code sets none) | `src/server.ts:754` |

A request body that fails the parser is answered with the codes of [architecture.md](architecture.md) section 7.3; the parser's own message, which can quote the body, is never sent or logged (`src/shared/http/body-parser-error.ts:78-115`; `src/shared/http/error-handler.ts:27-38`).

## 9. Input validation and response validation

### 9.1 Requests

Handlers validate `request.params`, `request.query` and `request.body` with Zod schemas kept next to the router (`*.schemas.ts`); a failure is a `ZodError`, answered 422 `validation.invalid_field` with one `field_errors` entry per issue. Enumerations, regexes for money (`^\d+\.\d{2}$`), hex addresses (`0x` and 40 hex digits, not the zero address, `src/modules/wallet/api/wallet.schemas.ts:19`), ISO date-times and string lengths are in those schemas. The staff recovery, Didit session and completion routes use `z.object({}).strict()`, so a non-empty body is refused (`src/modules/auth/api/staff/account-recovery.schemas.ts:11`, `:27`).

Exceptions, each re-read:

- `POST /internal/v1/intake-cases/:case_id/documents` takes the document type, room id, revision number and file name from headers: `Number(request.header("x-revision-number") ?? "1")` accepts `NaN`, negative numbers and fractions and passes them to a Prisma `where` (`src/modules/intake/api/intake-operations.router.ts:230-234`; `src/modules/intake/application/upload-case-document.service.ts:93`); the file name is cut to 255 characters in the service and not decoded at the edge, unlike the offering upload's `decodeOriginalFilename` (`src/modules/offering/api/offering-operations.router.ts:117`, `:153`). Not verified: what Prisma does with a `NaN` in a `where` (not exercised).
- `GET /internal/v1/intake-cases/:case_id/documents` reads `document_ref`, `room_id` and `document_type` from `request.query` by hand (`src/modules/intake/api/intake-operations.router.ts:263-266`).
- Routes that take no body ignore one: `POST /v1/auth/sessions/revoke-all` and `POST /v1/auth/account-closure/cancel` (`src/modules/auth/api/customer/customer-session.router.ts:49-56`; `src/modules/auth/api/customer/account-closure.router.ts:31-35`).
- A path identifier is validated as a non-empty string only ([architecture.md](architecture.md) section 11.1).
- `POST /v1/offerings/:offering_id/reservations/:reservation_id/reconfirm` parses `offering_id` and never uses it; ownership is enforced by the account match on the reservation (`src/modules/offering/api/offering.router.ts:96-102`).

### 9.2 Responses

Routers send `schema.parse(result)` ([architecture.md](architecture.md) section 8). The control it gives is that a field a schema does not list is dropped from the answer. Its failure mode is the 422 described there: a response that fails its schema is reported to the client as a request validation failure, names the internal path, and is not logged (L-14). Five call sites send an unparsed value: the Coinbase webhook acknowledgement and four staff routes of the intake operations router that return objects built by services (`src/modules/intake/api/intake-operations.router.ts:145`, `:171`, `:235`, `:272`).

> Pending #244: a response that fails its schema answers 500 `internal.response_invalid`, logged, with a fixed detail.

> Pending #245: the same for every remaining router.

> Pending #243: a stored malformed media URL is dropped from offering list, detail and featured responses; main answers 422 for the whole response.

The offering media URL validator checks only that the value is a URL with the `https` scheme; it does not reject credentials or control characters and does not store a canonical form (`src/modules/offering/api/offering.schemas.ts:5-7`; issue #218).

## 10. Error disclosure

| Case | What the client gets | Source |
| --- | --- | --- |
| An unexpected exception | 500 `internal.unexpected`, detail "An unexpected error occurred."; the exception is logged and not sent | `src/shared/http/error-handler.ts:66-72` |
| An `AppError` | Its own title and detail. Every `AppError` with a literal 5xx status found by a script over `src` has a fixed string detail. | `src/shared/errors/app-error.ts` |
| A Zod failure | 422 with `field_errors`: the field path, the Zod issue code and the Zod message | `src/shared/http/error-handler.ts:51-64` |
| A body-parser failure | A fixed detail; the parser's message is never used | `src/shared/http/body-parser-error.ts:21-76` |
| An unknown route | 404 `resource.not_found` whose detail echoes the method and the path | `src/shared/http/not-found.ts:5-14` |
| An error inside Better Auth | Better Auth's own body, outside the envelope | `/api/auth/*` |
| A device-auth error | Better Auth's `code` and message copied into `code`, `title` and `detail` | `src/modules/auth/api/customer/device-auth.router.ts:287-308` |

What a 5xx can still reveal, from the list of 5xx codes found by the script:

- Two Coinbase answers say that the server's own configuration is wrong: 500 `offering.coinbase_provider_key_invalid` ("The configured Coinbase CDP API key secret is neither a PEM EC key nor a base64 Ed25519 key.") and 500 `offering.coinbase_provider_auth_rejected` ("The onramp provider is misconfigured on our side...") (`src/modules/offering/infrastructure/http-coinbase-cdp.client.ts:247`, `:326`).
- Three 500 details describe internal state: `internal.dpop_jkt_missing` ("requireDpopOnly ran but left no DPoP jkt...", `src/modules/auth/api/customer/device-auth.router.ts:267`), `internal.auth_context_missing` and `internal.dpop_jkt_missing` in `src/modules/auth/api/customer/signing-requests.router.ts:161`, `:172` (never mounted).
- `503 identity.kyc_provider_unavailable`, `502 identity.kyc_provider_response_invalid` and the Coinbase 503 and 502 codes say which provider failed.
- `500 account.mapping_missing` says that an authenticated identity has no account row (`src/modules/auth/api/shared/require-authentication.ts:68-76`).
- The `trace_id` is whatever the caller supplied in `X-Trace-Id` when it supplied one (L-17).

The record rules out stack traces, SQL text, provider secrets and raw provider payloads in error payloads (`ERROR_HANDLING.md`); none of the above carries them.

> Pending #244: every 5xx carries a fixed detail; a Coinbase 4xx after the hold exists answers 502 `offering.coinbase_provider_request_rejected`.

## 11. Logging, redaction, trace ids and alerting

### 11.1 What is logged

`pino` writes JSON lines to stdout with `base: null`, so there is no process id or host name (`src/infrastructure/logging/logger.ts:6-8`); the level is `LOG_LEVEL` (default `info`). One access line is written per request by `pino-http`; run in a scratch process with the repository's options and `pino-http` 11.0.0, the line has `info` level, `req` (id, method, url, query, params, headers, remote address and port), `res`, `responseTime`. The trace id is `req.id`; the error handler's lines carry `trace_id` at top level. A 5xx adds an `error` line "request failed" with the serialised error (`src/shared/http/error-handler.ts:39-41`). Request and response bodies are not logged by any middleware.

### 11.2 Redaction

| Mechanism | What it hides | Source |
| --- | --- | --- |
| `pino` `redact` paths, censor `[REDACTED]` | request headers `authorization`, `cookie`, `x-csrf-token`, `x-internal-signature`, `x-passkey-challenge`, `dpop`, `x-original-filename`; response headers `set-cookie`, `set-auth-token`, `set-passkey-challenge`; top-level `password`, `token`, `access_token`, `refresh_token` | `src/infrastructure/logging/logger.ts:7-24` |
| `requestLogSerializer` | the values of query parameters whose name contains `email`, `phone`, `token`, `password`, `passwd`, `secret`, `signature`, `apikey`, `authorization`, `assertion`, `challenge` or `dpop`, or equals `code`, `state`, `otp`, `key`, `name`, `givenname`, `familyname`, `fullname` or `fulldisplayname`; any value or name containing `@`; the same masking in the `referer` header | `src/infrastructure/logging/request-log-redaction.ts:11-41`, `:59-66`, `:124-142` |
| `stripUrls`, `maskLongHexValues`, `toSanitizedError` | scheme-prefixed URLs (an RPC URL carries its key), 0x-prefixed hex of 40 or more digits, and error causes, in the job and chain paths that call them: the dead-letter consumer, the escrow finalizer, the wallet registry watcher | `src/shared/logging/log-redaction.ts:22-68`; `src/shared/jobs/dead-letter-consumer.ts:47-50`; `src/worker.ts:655` |

The error handler logs the raw error object for a 5xx and applies none of the masking above (`src/shared/http/error-handler.ts:40`). The request-path chain reader builds its error without the RPC URL (`src/shared/errors/chain-state-unavailable-error.ts`), but an exception from another library (the database driver, SMTP, S3) is logged as thrown. Not verified: what those libraries put in their error messages.

### 11.3 Trace ids

`requestContext` accepts any `x-trace-id` header value, trimmed, without a length or character check, and copies it into the response header, the error envelope, log lines, audit `changes` and job payloads (`src/shared/http/request-context.ts:8-14`). `enqueueTransactionalJob` puts it into the job, the dead-letter consumer returns it verbatim, and the alert webhook prints it unmasked in the message line (`src/shared/jobs/enqueue-job.ts:52`, `src/shared/jobs/dead-letter-consumer.ts:14-20`, `src/shared/jobs/dead-letter-alert-webhook.ts:45`). Issue #217 tracks validating it (L-17).

### 11.4 Alerting

Nothing sends a log line to a person except the dead-letter webhook. `AD-089`'s Slack and email delivery is not built; the wallet registry watcher, KYC and onramp late-evidence warnings are structured log lines and a gauge on the worker's loopback `/metrics` (`src/shared/health/worker-heartbeat.ts:45-54`, `docs/wallet-registration-operations.md`). The dead-letter path:

| Step | Behaviour | Source |
| --- | --- | --- |
| Log | One `error` line per dead-lettered job with `event: "job.dead_lettered"`, queue, ids, `trace_id`, owner, tier, attempts and `last_error` (URLs stripped, cut to 500 characters). The payload is never logged. | `src/shared/jobs/dead-letter-consumer.ts:9`, `:62-88` |
| Webhook | If `DEAD_LETTER_ALERT_WEBHOOK_URL` is set (`https` required when `NODE_ENV=production`), a JSON POST with a Slack-compatible `text` and a `dead_letter` object; `last_error` additionally has hex values masked and email addresses replaced; redirects are refused; the call times out after 5 seconds (`DEAD_LETTER_ALERT_TIMEOUT_MS`, `:6`); a failure is logged at `warn`, with no retry. The URL is a credential and is never logged. | `src/shared/jobs/dead-letter-alert-webhook.ts:6`, `:27-35`, `:65-107`; `src/config/environment.ts:381`, `:573-579` |
| Replay | `npm run jobs:replay-dead-letter` writes one log line and no audit row; the word `audit` does not occur in either file (grep). | `src/shared/jobs/dead-letter-replay.ts`; `src/cli/replay-dead-letter-job.ts` |

> Pending #233: dead-letter replay writes an audit row, and `--operator` becomes mandatory with `--confirm`.

> Pending #241: the dead-letter alert is throttled per queue (`DEAD_LETTER_ALERT_WINDOW_MINUTES`) and carries an "N more" line.

The operator procedure is in [dead-letter-jobs.md](dead-letter-jobs.md).

## 12. The audit log

### 12.1 Where and how

`audit.audit_log` has the columns `audit_log_id`, `event_key` (unique), `actor_account_id`, `action`, `resource_type`, `resource_id`, `changes` (JSONB), `ip_address_hash`, `user_agent_hash` and `created_at` (`prisma/schema/schema.prisma:1065-1083`). There is no shared wrapper: each repository writes its own rows with `auditLog.create`, in the same transaction as the state change it describes (for example `src/modules/intake/repository/prisma-intake.repository.ts:2095-2100` after the case update). The exception is the authentication events, which a Better Auth plugin writes after the fact through `PrismaAuthAuditSink` with `createMany` and `skipDuplicates`, so the unique `event_key` makes them idempotent (`src/modules/auth/repository/shared/prisma-auth-audit-sink.ts:20-34`; `better-auth-audit.plugin.ts`). Login identifiers and DPoP keys appear in audit resource ids only as an HMAC-SHA256 keyed with `BETTER_AUTH_SECRET` (`src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:268`, `:344`, `:356`).

The record (AD-148) describes automatic writes through a shared wrapper for every state-changing call; the code has no wrapper, so a new write path has an audit row only if its author adds one.

### 12.2 Events written

Static action names found by a script over `src/**/*.ts` (literals after `action:`), grouped by prefix. Names built at run time are listed after the table.

| Prefix | Actions |
| --- | --- |
| `authentication.` | `identity_created`, `login_succeeded`, `oauth_verified`, `login_failed`, `session_created`, `session_revoked` (Better Auth plugin, `src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:125-276`; `oauth_verified` replaces `login_succeeded` when the session completes a provider sign-in, `:211-215`); `staff_invitation_issued`, `staff_invitation_accepted`, `staff_invitation_revoked`, `staff_bootstrap_invitation_issued`; `staff_webauthn_credential_registered`, `staff_webauthn_challenge_succeeded`, `staff_webauthn_challenge_failed`; `staff_role_granted`, `staff_role_revoked`, `staff_account_offboarded`, `staff_account_recovery_started`, `staff_account_recovery_delivery_failed`; `account_recovery_case_opened`, `account_recovery_didit_session_created`, `account_recovery_primary_review_recorded`, `account_recovery_sessions_revoked`, `account_recovery_restriction_cleared`, `account_recovery_completed`, `account_recovery_link_sent`, `account_recovery_link_delivery_failed`, `account_recovery_reenrolment_notice`; `device_replacement_requested`, `device_replacement_unavailable`, `device_replacement_completed`, `device_revoked`, `login_method_removed`; `customer_account_closed`, `customer_closure_request_rejected` |
| `identity.` | `kyc_session_started`, `kyc_session_start_failed`, `proof_of_address_session_started`, `proof_of_address_session_start_failed`, `didit_webhook_received`, `didit_webhook_unmatched`, `kyc_renewal_due` |
| `intake.` | `case_draft_created`, `case_created_by_staff`, `case_submitted`, `case_resubmitted`, `case_approved_for_final_offering`, `case_post_ipo_structuring_started`, `case_partner_organization_assigned`, `case_legal_structuring_recorded`, `case_appraisal_recorded`, `evidence_reviewed`, `information_request_published`, `information_request_withdrawn`, `information_request_expired`, `correction_requested`, `correction_cancelled`, `correction_failed`, `legal_practice_created`, `legal_practice_status_updated`, `appraisal_firm_created`, `appraisal_firm_status_updated`, `room_deleted`, `room_photo_deleted`, `room_photo_representative_selected` |
| `offering.` | `opened_for_approved_case`, `closed_with_case`, `presentation_updated`, `disclosure_document_uploaded`, `disclosure_pack_published`, `final_terms_published`, `materiality_classified`, `reservation_created`, `reservation_reconfirmed`, `reservation_lapsed`, `reconfirmation_reminder_sent`, `reconfirmation_window_opened_notification_sent`, `finalized`, `onramp_late_evidence_recorded`, `onramp_late_evidence_reviewed` |
| `settlement.` | `wallet_registration_requested`, `wallet_registration_replaced`, `wallet_registration_expired`, `wallet_registration_confirmed`, `wallet_registration_confirmation_conflict`, `wallet_registration_address_mismatch`, `wallet_registration_evidence_flagged`, `wallet_registration_reconciled` (written through the `audit(...)` helper of `src/modules/wallet/repository/prisma-wallet.repository.ts:455`) |

Built at run time: `authentication.account_recovery_case_approved` and `_rejected` (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:256`), `intake.case_approved` and `intake.case_rejected` (`src/modules/intake/repository/prisma-intake.repository.ts:2095`), `intake.case_<outcome>` for case closure (`:2331`), `intake.<reversal command>` (`:263`), `settlement.wallet_registration_evidence_<recorded|refreshed>` (`src/modules/settlement/repository/prisma-settlement.repository.ts:651`, `src/modules/settlement/repository/settlement.repository.ts:304`) and `settlement.wallet_registration_evidence_<recorded|replaced>` (`src/modules/wallet/repository/prisma-wallet.repository.ts:501`).

Not audited: reads. No action name in the inventory is a read of customer data, so staff reads such as `GET /internal/v1/kyc-accounts/:account_id` and `GET /internal/v1/accounts` leave no audit row (inferred from the inventory; not every call site was traced). Money events are in `money.money_events`, not in the audit log. The shared request audit fields `ip_address_hash` and `user_agent_hash` are never written by any code path (grep for `ipAddressHash` and `userAgentHash` finds only the session mirror's own `userAgentHash`, `src/modules/auth/infrastructure/shared/prisma-session-mirror.ts:44`, `:72`).

### 12.3 Immutability and retention

`audit.audit_log` has no trigger that rejects `UPDATE` or `DELETE` (no migration creates one; grep over `prisma/migrations`). One code path updates an audit row: the Didit webhook receipt, an `identity.didit_webhook_received` row whose `changes` are rewritten as the event is processed (`src/modules/identity/repository/prisma-kyc.repository.ts:871-878`, `updateReceipt`). No code deletes audit rows, and no retention period or purge exists for the table.

Tables that are append-only in the database, by trigger:

| Table | Trigger | Migration |
| --- | --- | --- |
| `intake.intake_case_events` | `intake_case_events_append_only` | `prisma/migrations/20260918120000_intake_case_event_ledger/migration.sql:56` |
| `money.money_events` | `money_events_append_only` (`TRUNCATE` is not guarded, per `README.md:258` and the migration header) | `prisma/migrations/20261018131000_money_events_append_only/migration.sql:45-49` |
| `money.onramp_webhook_receipts` | `onramp_webhook_receipts_append_only` | `prisma/migrations/20261117203000_onramp_webhook_receipts/migration.sql:68-72` |
| `intake.submission_revisions` | `submission_revisions_append_only` | `prisma/migrations/20260831163000_immutable_submission_revisions/migration.sql:13` |
| `money.onramp_late_evidence` | `onramp_late_evidence_guard`: the only change allowed is setting `reviewed_at` once on an entry that has none (`guard_onramp_late_evidence_change`, `:81-104`) | `prisma/migrations/20261117203500_onramp_late_evidence/migration.sql:106` |

A sixth trigger, `intake_case_events_reversal_validation`, validates reversal events and does not make a table append-only (`prisma/migrations/20260918140000_intake_case_reversal_operations/migration.sql:27`).

## 13. Webhook verification

| | Didit | Coinbase CDP onramp |
| --- | --- | --- |
| Route | `POST /webhooks/didit` (`src/app.ts:931`) | `POST /webhooks/coinbase-onramp` (`src/app.ts:579`), mounted only with the CDP client and `COINBASE_ONRAMP_WEBHOOK_SECRET` |
| Body as verified | the JSON the parser produced, re-serialised with sorted keys (`canonicalize`) | the exact bytes received (`express.raw`, 256 kb) |
| Headers | `X-Signature-V2` (64 hex digits) and `X-Timestamp` (10 digits) (`src/modules/identity/api/kyc.router.ts:100-103`) | `X-Webhook-Signature`, shaped `t=<unix seconds>,v0=<hex>,h=<names>,v1=<hex>`, at most 2048 characters; the deprecated `X-Hook0-Signature` is read only when the first is absent (`src/modules/offering/api/coinbase-onramp-webhook.router.ts:58-59`; `src/modules/offering/infrastructure/coinbase-onramp-webhook-verifier.ts:55`) |
| Algorithm | HMAC-SHA256 with `DIDIT_WEBHOOK_SECRET` (at least 16 characters, `src/config/environment.ts:245`), hex digest | HMAC-SHA256 with `COINBASE_ONRAMP_WEBHOOK_SECRET` over `"<t>." + raw body`; accepted if any `v0` value matches |
| Comparison | `timingSafeEqual` | `timingSafeEqual` |
| Replay window | the timestamp must be within 300 seconds of the server clock, either direction, and the body's own numeric `timestamp` must equal the header (`src/modules/identity/infrastructure/didit-webhook-verifier.ts:17-21`) | `t` within 300 seconds, either direction (`src/modules/offering/infrastructure/coinbase-onramp-webhook-verifier.ts:5`, `:37`) |
| Duplicate delivery | the worker skips an event id it has already recorded (`docs/dead-letter-jobs.md`, "What makes it safe") | the receipt table is unique on the event id (`X-Event-Id`, or `body-sha256:<digest>` when absent) and a duplicate is dropped (`src/modules/offering/api/coinbase-onramp-webhook.router.ts:61-63`; `src/modules/offering/repository/prisma-offering.repository.ts:982`) |
| A bad signature or time | 401 `identity.didit_webhook_invalid` | 401 `offering.coinbase_webhook_invalid` |
| A verified delivery | the body is validated, a job is queued, the parsed acknowledgement is sent | every verified delivery gets 200 `{"received":true}`, including an unknown event type or a body of an unrecognised shape, so that Coinbase does not retry what a retry cannot fix |
| Processing | worker, `provider_events.didit_webhook` | worker, `provider_events.coinbase_onramp_webhook`; the body is a trigger only: the worker re-fetches the reservation's transactions from CDP |
| Rate limit | none | none |

Both receivers acknowledge after durable queueing and do no business processing in the request (`src/modules/identity/application/kyc.service.ts:331-347`; [architecture.md](architecture.md) section 9.2). The Coinbase receipt stores only the event id, event type, transaction id, `txHash` and `partnerUserRef`; the body, the signature and the secret are not stored (`coinbase-onramp-webhook.router.ts`, header comment). Not verified: a real signed Coinbase delivery on staging (the verifier's comment says none has been checked, `src/modules/offering/infrastructure/coinbase-onramp-webhook-verifier.ts:18-25`) and the JSON key names of its payload, which are assumed; a real Didit delivery.

## 14. Uploads

Customers have no upload route: `src/modules/intake/api/intake.router.ts` registers eight routes and none takes a file. All uploads are staff-only and require `admin_operations` and WebAuthn (`staffOnly`, `src/modules/intake/api/intake-operations.router.ts:114`; `src/modules/offering/api/offering-operations.router.ts:46`).

| | Intake case documents | Offering disclosure documents |
| --- | --- | --- |
| Route | `POST /internal/v1/intake-cases/:case_id/documents` | `POST /internal/v1/offerings/:offering_id/documents` |
| Body | the raw request stream, not multipart; metadata in `X-Document-Type`, `X-Room-Id`, `X-Revision-Number`, `X-Original-Filename` | the raw request stream; `X-Document-Type`, `X-Original-Filename` |
| Types | `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, the Word `.docx` and Excel `.xlsx` media types (`src/modules/intake/application/upload-case-document.service.ts:14`) | the same six (`src/modules/offering/application/upload-offering-document.service.ts:15-22`) |
| Content check | declared `Content-Type` only for PDF and Office files; a room photo's leading bytes are compared with its declared image type and the image is decoded (`hasSupportedImageSignature`, `createThumbnail`, at most 40,000,000 pixels) (`:105`, `:145-164`, `:12`) | declared `Content-Type` only |
| Size | 100 MB, counted while reading; empty is 422 | 100 MB; empty is 422 |
| Other limits | at most five accepted photos per room (`:99`, `:125`) | document type from the closed list of disclosure document types |
| Scan | ClamAV before anything is stored (`:110`) | ClamAV before anything is stored (`:107`) |
| Store | `MINIO_PRIVATE_BUCKET`, key `intake/<case_id>/revisions/<n>/<document_id>` (`src/infrastructure/storage/storage-buckets.ts:13-25`), metadata `sha256` and the file name cut to 255 characters | `MINIO_DISCLOSURES_BUCKET`, key `offerings/<offering_id>/<document_id>` |
| Download | `GET .../documents?document_ref=` for staff; the whole object is read into memory (`src/modules/intake/api/intake-operations.router.ts:280-284`) | staff list and download; investors through `GET /v1/offerings/:offering_id/documents/:document_id/download`, which checks that the account may access the document (`getAccessibleDocument`) and streams the object |

Storage is never exposed: there is no presigned URL anywhere in `src` (grep for `getSignedUrl` and `presign` finds none); every read and write goes through the API's S3 client with path-style addressing, and the compose files do not publish MinIO's S3 port (`docker-compose.staging.yml:35-46` publishes the console on `127.0.0.1` only). The key is built from identifiers the server generated, not from the file name (`objectKey` refuses anything outside `[A-Za-z0-9/_-]` and `..`, `src/infrastructure/storage/storage-buckets.ts:13-25`). The buckets are created by `storage-init`: private, KYC, disclosures and audit are versioned, disclosures and audit have object lock, quarantine expires after 30 days (`src/infrastructure/storage/ensure-minio-bucket.ts:25-31`); the code reads only the private and the disclosures bucket. The api uses the same access key and secret that staging gives MinIO as its root user (`docker-compose.staging.yml:43-44`; `src/server.ts:503-510`), so the api holds the object store's root credential.

### 14.1 Malware scanning

`ClamAvScanner.scan(buffer)` opens a TCP connection to `CLAMAV_HOST:CLAMAV_PORT`, sends the INSTREAM command, then the data in chunks of 64 KiB each preceded by a 4-byte big-endian length, then a zero length, and reads the answer; a reply containing `FOUND` is `infected`, one containing `OK` is `clean`, anything else is an error; the call is abandoned after 120 seconds (`src/infrastructure/antivirus/clamav-scanner.ts:8-28`). An error answers 503 `intake.document_scanner_unavailable` or `offering.document_scanner_unavailable` and stores nothing; `infected` answers 422 `*.document_malware_detected`. The scan happens before the object is written (`src/modules/intake/application/upload-case-document.service.ts:110-113`).

The host defaults to `127.0.0.1` when `CLAMAV_HOST` is unset, without a log line (`src/server.ts:497`), and the staging compose file lists `CLAMAV_HOST` and `CLAMAV_PORT` only under the one-shot `storage-init` service (`docker-compose.staging.yml:89-90`), not under the `&app-environment` anchor. `.env.example` lists neither variable. The api and the worker therefore receive them only if `.env.staging` defines them (both services load that file through `env_file`, `docker-compose.staging.yml:131-132`, `:275-276`). Not verified: `.env.staging`.

> Pending #236: `CLAMAV_HOST` and `CLAMAV_PORT` move into the staging `&app-environment` anchor (defaults `clamav` and `3310`) and out of `storage-init`.

The command bytes on main are wrong: the source is `Buffer.from("zINSTREAM\\0")`, which is the nine characters `zINSTREAM` followed by a backslash and the digit `0` (eleven bytes), not a NUL byte. The bytes, printed with `node`, are `7a494e53545245414d5c30`. A `z`-prefixed clamd command ends at a NUL, so clamd cannot recognise this one (the descriptions in #205 and #225 report `UNKNOWN COMMAND` from clamd 1.4.6; not reproduced here). Every upload through a reachable clamd therefore answers 503. No test exercises the scanner: no file under `tests/` mentions `ClamAvScanner` (grep); the two that import its module, `tests/upload-offering-document-service.test.ts:6` and `tests/offering-document-upload.integration.test.ts:11`, import only the `MalwareScanner` type and inject a stub.

> Pending #225: writes a NUL after `zINSTREAM` and adds `npm run clamav:smoke`; #229 duplicates it.

`clamd.conf` sets `MaxFileSize`, `MaxScanSize`, `MaxRecursion` and `MaxFiles` and no `AlertExceedsMax` (`infrastructure/clamav/clamd.conf:13-16`), so a file over a limit is reported clean by clamd's own documented default instead of being flagged (issue #246; derived from the configuration and the issue, not run).

### 14.2 Deleting a document

Deleting a room photo or a room soft-deletes the rows (`deleted_at`, `deleted_by_account_id`, `deletion_reason`, `retention_until` set 30 days ahead) and then removes the objects with `.catch(() => undefined)`: a failed removal is neither retried nor logged (`src/modules/intake/application/upload-case-document.service.ts:38-48`, `:65-80`). The comment says removal "can be retried by the purge job"; no purge job exists (grep for `purge` over `src` finds only that comment) and nothing reads `retention_until` (`prisma/schema/schema.prisma:102`). The private bucket is versioned (`src/infrastructure/storage/ensure-minio-bucket.ts:27`), so an S3 `DeleteObject` without a version id writes a delete marker and keeps the earlier version; whether the bytes of a deleted document stay in the bucket was not exercised against MinIO. An object written before a failed database insert is removed on a best-effort basis too (`src/modules/intake/application/upload-case-document.service.ts:137-138`; `src/modules/offering/application/upload-offering-document.service.ts:157`).

### 14.3 Memory

Both upload services collect every chunk in an array and then `Buffer.concat` it, so one 100 MB upload holds about 200 MB at once, and the whole buffer goes to ClamAV and to S3 (`src/modules/intake/application/upload-case-document.service.ts:101-104`; `src/modules/offering/application/upload-offering-document.service.ts:77-102`). There is no concurrency cap. The only compose service with a memory limit is ClamAV (`docker-compose.staging.yml:60`). The routes are staff-only.

## 15. Personal data and retention

What the code enforces, store by store. "None" means no code path deletes or expires the data.

| Data | Where | Enforced retention |
| --- | --- | --- |
| Account contact email | `account.accounts.protected_contact_email` (plain text) | none |
| Better Auth user, session, account and verification rows | `public.auth_*` tables | verification identifiers are stored hashed (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:240`); OAuth tokens are encrypted (`:217`); session rows follow Better Auth's expiry |
| Session mirror | `auth.sessions`: channel, device label, timestamps, a user-agent HMAC (key `BETTER_AUTH_SECRET`) | none found (`src/modules/auth/infrastructure/shared/prisma-session-mirror.ts:44`, `:72`) |
| Login identifiers and DPoP keys in audit rows | HMAC-SHA256, not reversible | none |
| KYC eligibility | `identity.kyc_eligibility`: status, countries, timestamps; no provider payload, document data, biometrics or addresses | none; see [didit-kyc.md](didit-kyc.md) |
| Verified display names | Redis, key `kyc_display:<account_id>`: given, family and display name, ID document country | 24 hours (`src/infrastructure/cache/redis-protected-profile-cache.ts:53-55`, key at `:76-77`); invalidated when a KYC session starts or a webhook changes the state |
| Access log | log store (outside the repository): remote address and port, method, redacted URL | none in code |
| Audit rows | `audit.audit_log` | none (section 12.3) |
| Idempotent responses | `audit.idempotency_keys.response_body` | intended 48 hours; not enforced (section 4.1) |
| Onramp webhook receipts | `money.onramp_webhook_receipts`: ids only | none; append-only |
| Dead-lettered job payloads | `pgboss` schema; the payload can hold personal data | 30 days (`src/shared/jobs/job-queues.ts:12`, `:19-22`) |
| DPoP proofs | `auth.dpop_replays` | 120 seconds, pruned hourly (`maintenance.dpop_replay_prune`) |
| Device challenges, signing requests | `auth` tables | pruned hourly (`maintenance.device_challenge_prune`, `maintenance.signing_request_prune`, `src/worker.ts:553-565`) |
| Staff invitation tokens | SHA-256 hash only, 72 hours | the token expires; the row is kept |
| Uploaded documents | private bucket | soft delete with an unread `retention_until` (section 14.2) |
| Closed accounts | `auth.account_closure_requests`; an approved request revokes every session of the customer first (`src/modules/auth/application/shared/account-closure.service.ts:78-84`) and then sets the account to `suspended_restricted` (`src/modules/auth/repository/shared/prisma-account-closure.repository.ts:92-139`) | no erasure or anonymisation code exists (grep for `anonymi`, `erasure` and `deleteUser` finds only session deletion) |

There is no application-level encryption of stored personal data: a grep for `encrypt`, `cipher` and `aes` over `src` finds only Better Auth's `encryptOAuthTokens` (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:217`). Protection at rest is the database's and the object store's. The design record's `DATA_ENCRYPTION.md` is the place to compare; it was not read for this chapter.

## 16. Secrets in configuration

All configuration is read from environment variables through one Zod schema; only `better-auth.cli.ts` and the bucket initialiser read `process.env` themselves (`src/config/environment.ts:650-652`; [architecture.md](architecture.md) section 3.1). Every process validates the whole schema, so the worker needs `BETTER_AUTH_SECRET` and the api needs the Didit identifiers although neither uses them.

| Variable | Holds | Validation | Read by |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | signs session cookies and bearer tokens; HMAC key for audit identifiers and the user-agent mirror | at least 32 characters (`src/config/environment.ts:18`) | api |
| `DATABASE_URL`, `DIRECT_DATABASE_URL` | database password | `postgresql://` URL (`:14`); the second is read by `prisma.config.ts` | api, worker, CLI; the second is also passed to api and worker in staging (`docker-compose.staging.yml:135`) |
| `SMTP_PASSWORD` | mail credential | non-empty (`:166`) | api, worker |
| `GOOGLE_CLIENT_SECRET`, `APPLE_PRIVATE_KEY` | sign-in provider secrets | required when the provider is enabled (`:413`, `:425`) | api |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | Google service account, base64 | non-empty (`:114`) | api |
| `DIDIT_API_KEY`, `DIDIT_WEBHOOK_SECRET` | Didit API key and webhook secret | non-empty; at least 16 characters (`:242`, `:245`) | api, worker |
| `COINBASE_CDP_API_KEY_SECRET`, `COINBASE_ONRAMP_WEBHOOK_SECRET` | CDP signing key and webhook secret | non-empty; the webhook secret needs at least 16 characters and the CDP settings (`:255`, `:263-266`, `:480-489`) | api, worker |
| `MINIO_SECRET_KEY` | object store credential | at least 8 characters (`:220-223`) | api |
| `CHAIN_OPERATOR_PRIVATE_KEY` | the platform's own wallet key | `0x` and 64 hex digits (`:294-300`) | worker, operator command; present in the api's environment (section 17) |
| `CHAIN_RPC_URL` | RPC URL, which carries the provider's key | URL (`:293`) | api, worker |
| `DEAD_LETTER_ALERT_WEBHOOK_URL` | a Slack-style incoming webhook URL, itself a credential | `https` in production (`:573-579`) | worker |
| `RATE_LIMIT_CACHE_URL`, `PROFILE_CACHE_URL` | Redis URLs, which may carry a password | `redis://` or `rediss://` (`:168-174`, `:204-209`) | api, worker |

Handling:

- `.env` and `.env.*` are ignored by Git except `.env.example` (`.gitignore:3-5`). Staging's one source of configuration is `.env.staging`, owner-readable only by policy (`secrets/README.md`); `scripts/deploy/staging.sh` checks that the file is readable and contains a non-empty `POSTGRES_PASSWORD` line (`scripts/deploy/staging.sh:8-16`), then runs `docker compose config -q`, which fails when an interpolation marked `:?` in the compose file (`POSTGRES_PASSWORD`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`) is unset (`scripts/deploy/staging.sh:18`; `docker-compose.staging.yml:8`, `:43-44`, `:82-83`, `:108`, `:134-135`, `:235-236`); it checks no other key and does not check file permissions.
- Both staging application services load the whole of `.env.staging` as `env_file` (`docker-compose.staging.yml:131-132`, `:275-276`), so every key in it, including `POSTGRES_PASSWORD`, reaches both containers; the `&app-environment` anchor wins only for the names it lists (Compose gives `environment:` entries precedence over `env_file`; observed at the end of this item). `AGENTS.md:21` and the comment at `docker-compose.staging.yml:213-215` say a variable reaches the containers only through the anchor; the `env_file` lines say otherwise. Observed in this pass with Docker Compose v5.6.1 on a copy of `docker-compose.staging.yml` in a scratch directory, next to a dummy `.env.staging` that held `DATABASE_URL`, one key the anchor does not list, and placeholder values for the three variables the file requires: `docker compose --env-file .env.staging config --format json` renders the key that is only in the file in the `environment` of both `vistablox-api` and `worker`, and for `DATABASE_URL` it renders the anchor's value, not the file's. Not verified: the real `.env.staging`, which is a host file.
- The values in `.env.example` for `BETTER_AUTH_SECRET` (`.env.example:19`) and `SMTP_PASSWORD` (`:108`) are placeholders that satisfy validation: the example secret is 42 characters, above the minimum of 32, so a deployment that copies the example boots with a signing secret that is written in the repository. The code itself notes that production SMTP is still a placeholder host (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:228`).
- No log line prints a configuration value. The dead-letter webhook URL is never logged (`src/shared/jobs/dead-letter-alert-webhook.ts:60-63`); RPC URLs are stripped in the job paths (section 11.2). A configuration error at boot is a Zod error. Observed in this pass: `npx tsx src/server.ts` with `NODE_ENV=production` and three invalid values (a 13-character `BETTER_AUTH_SECRET`, a `DATABASE_URL` that is not a URL, a non-numeric `PORT`) exited with code 1 and printed a stack trace and a ZodError whose entries give `path`, `code` and `message`; the three supplied strings occur zero times in the output. Only the environment validation ran before the exit (`src/server.ts:98`, `src/config/environment.ts:650-651`).
- `NODE_ENV` defaults to `development` and is not pinned in the staging compose file: the images set `NODE_ENV=production` (`Dockerfile:33`, `:44`), but a `NODE_ENV` line in `.env.staging` overrides it. With `NODE_ENV` unset, every production-only refinement is skipped, including the one that forbids `PLAY_INTEGRITY_POLICY` other than `strict` (`src/config/environment.ts:8`, `:585-592`). `APP_ENV` fails closed: unset means production, and the staging-only switches `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` and `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING` refuse to boot unless `APP_ENV=staging` (`src/config/environment.ts:99`, `:553-568`).

> Pending #238: `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` and the staging single-reviewer behaviour are removed.

## 17. The self-custody boundary

The statement of the rule, the code that meets it, the two facts that qualify it and the record conflict C-008 are in [architecture.md](architecture.md) section 10. In security terms: no code path holds, receives or uses a customer's key; transfer preparation returns unsigned calldata; the one signing key is the operator's, held by the worker and the operator command and also present in the api's environment wherever the escrow gate is configured.

## 18. Dependency posture

Direct dependencies are pinned to exact versions in `package.json:32-60` for the security-relevant libraries (`better-auth` 1.7.2, `express` 5.2.1, `helmet` 8.1.0, `cors` 2.8.5, `zod` 4.5.4, `jose` 6.2.10, `@simplewebauthn/server` 13.3.3, `nodemailer` 9.1.0, `pg` 8.16.3, `pg-boss` 12.29.0, `pino` 10.3.1) and by range for a few (`viem`, `redis`, `jimp`, `@peculiar/x509`). The lock file pins every transitive version. `busboy` and `@types/busboy` are dependencies that no file under `src` imports (grep).

Neither `.github/workflows/ci.yml` nor the `Dockerfile` runs `npm audit` (grep). In `package-lock.json` `vitest`, `vite`, `prisma`, `mysql2`, `tsx` and `typescript` carry `devOptional: true`, not `dev: true`, which npm keeps when installing with `--omit=dev`, the command the runtime image uses (`Dockerfile:22`).

`npm audit --package-lock-only --json`, run against `package-lock.json` at 48aa967 on 2026-11-20, reported 44 vulnerable packages: 2 critical, 38 high, 3 moderate and 1 low, from 40 distinct advisories (counted by script over the JSON; the run changed no file; the registry's advisory data moves, so a later run gives other numbers). Advisory titles and version ranges were read, not the full texts. Among the packages that `src` imports or that sit under a library it imports: `better-auth` 1.7.2 is listed as critical and direct (an OAuth state used as a magic link to sign in as another user, and an OAuth proxy that lets an attacker sign in as another user; both ranges end below 1.7.7); `proxy-addr` under `express` 5.2.1 is critical (IP spoofing through an IPv4-mapped IPv6 trust subnet, range below 2.0.8), and `TRUST_PROXY` feeds that library; `body-parser` is high (denial of service through trailing bytes after a compressed body, range 2.0.0 up to below 2.4.0), reachable through `express.json` and `express.raw`; `zod` 4.5.4 is high (memory exhaustion on oversized constrained collections, range below 4.6.6), and the same advisory lists a nested `zod` 3.25.76 under 16 `@jimp/*` packages; `nodemailer` 9.1.0 is listed high, with 2 high and 11 moderate advisories (address parsing and SMTP reply handling); `jimp` is listed high through 27 `@jimp/*` packages. No file under `src` imports `fast-uri`, `mysql2`, `source-map-js`, `vite`, `vitest` or `qs` (searched), which the run also lists; whether a library under them reaches them was not traced. Not verified: whether any advisory applies to the options and plugins this repository enables. This pass did not run `npm install`. The containers run as `root`: the `Dockerfile` has no `USER` (`Dockerfile:31-48`).

## 19. Known limitations

Defects found in the code, stated as found. None is fixed here. "Risk" is an assessment of the effect on a deployed system: high, medium or low. "Issue" and "PR" are the GitHub numbers where a tracker exists. "Derived" means read from code or library source and not reproduced.

| ID | Area | Defect | Evidence | Risk | Issue / PR |
| --- | --- | --- | --- | --- | --- |
| L-1 | Uploads | The scanner writes a backslash and `0` instead of a NUL after `zINSTREAM`; clamd cannot parse the command, so every upload through a reachable clamd answers 503. No test runs the real scanner. | `src/infrastructure/antivirus/clamav-scanner.ts:16`; no test instantiates `ClamAvScanner` | high | #205; PR #225 (#229 duplicate) |
| L-2 | Uploads, config | The staging compose file gives `CLAMAV_HOST` and `CLAMAV_PORT` only to the `storage-init` service, which never reads them, and `.env.example` lists neither; unless `.env.staging` sets them, the api falls back to `127.0.0.1` without a log line. Not verified: `.env.staging`. | `docker-compose.staging.yml:89-90`; `src/server.ts:497` | high | #208; PR #236 |
| L-3 | Uploads | A scanner failure of any cause (unknown command, refused connection, timeout, oversize reply) produces the same 503, with no cause and no log; clamd's size and recursion limits flag nothing, so a file over a limit passes as clean (derived). | `src/modules/intake/application/upload-case-document.service.ts:109-111`; `src/modules/offering/application/upload-offering-document.service.ts:105-115`; `infrastructure/clamav/clamd.conf:13-16` | medium | #247, #246 |
| L-4 | Idempotency | A key is scoped to `(key, endpoint)`: another account, or another `:offering_id` or `:reservation_id`, with the same key and body is answered with the first caller's stored response and its handler does not run. Reproduced with a stand-in store. | `src/shared/http/idempotency.ts:36`, `:45`, `:91`; `src/infrastructure/idempotency/prisma-idempotency-store.ts:12-14`; `prisma/schema/schema.prisma:1097` | medium | PR #244 (account and path scope); register C-006 |
| L-5 | Idempotency | No in-flight lock: two concurrent first requests with one key both run the handler. Reproduced with a stand-in store. | `src/shared/http/idempotency.ts:97-110` | medium | none |
| L-6 | Idempotency | `expires_at` is written (48 hours) but never read or purged, so a stored response, including a 4xx, replays for as long as the row exists. | `src/shared/http/idempotency.ts:11`, `:75`; `src/infrastructure/idempotency/prisma-idempotency-store.ts:12-14` | low | register C-006 |
| L-7 | Rate limiting | Rate limiting needs Redis at boot, never reconnects, and fails open on every store error; staging defines no Redis service. | `src/server.ts:147`, `:152-158`; `src/shared/http/rate-limit.ts:54-62`; `docker-compose.staging.yml` | medium | #175 |
| L-8 | Rate limiting | The tightened tier covers only authentication surfaces; reservation creation, reconfirmation, finalization, wallet registration, transfer preparation and account closure get the baseline limit. The record puts them in the tightened tier. | `src/app.ts:572`, `:786-787`, `:950`, `:1047` (tightened tier mounts); the baseline limiter in `src/modules/auth/api/shared/require-authentication.ts:114-124` | medium | none |
| L-9 | Sessions | `POST /v1/auth/sessions/devices/:jkt/revoke` revokes only the caller's sessions but then cancels the pending and signed signing requests of the active device that owns `:jkt`, whoever owns it; the route discards the caller's account id. Signing requests exist only behind a flag that is hard-coded off. | `src/modules/auth/api/customer/customer-session.router.ts:73-85`; `src/modules/auth/application/customer/customer-session.service.ts:103-108`; `src/modules/auth/application/customer/cancel-signing-requests.service.ts:16-19`; `src/modules/auth/repository/customer/prisma-device.repository.ts:148-153`; `src/modules/auth/repository/customer/prisma-signing-request.repository.ts:173-180` | medium | #213; PR #234 |
| L-10 | Availability | The `pg` pool that Better Auth uses has no `error` listener; `pg-pool` emits `error` on the pool when an idle client fails, and an unhandled `error` event ends the process. Prisma's adapter handles its own pool. Derived from `pg-pool` 3.14.0. | `src/server.ts:101`; the only `error` listeners in `server.ts` are at `:103` (pg-boss), `:149` and `:172` (Redis) | high | none |
| L-11 | Availability | Shutdown has no force-exit timer; its callback is `async` over `Promise.all`, so one failing task becomes an unhandled rejection; no `unhandledRejection` or `uncaughtException` handler exists; compose sets no `stop_grace_period`; the worker's `heartbeat.stop()` and the last two steps are unguarded. | `src/server.ts:761-781`; `src/worker.ts:902-914` | medium | none |
| L-12 | Device auth | The two Google calls of the Play Integrity check have no timeout, a new access token is fetched per decode, and any failure is reported to the client as an invalid token. | `src/modules/auth/infrastructure/customer/google-play-integrity.decoder.ts:59`, `:96`; `src/modules/auth/application/customer/android-attestation-verifier.ts:327-331` | medium | none |
| L-13 | Email | The SMTP transport has no timeouts. Sends awaited in requests fail the request (staff invitation, staff recovery) or are swallowed without a log (device replacement code, recovery notices). | `src/infrastructure/email/smtp-email-sender.ts:88-93`; `src/modules/auth/application/customer/device-replacement.service.ts:103-112`; `src/modules/auth/application/staff/account-recovery.service.ts:50-58`, `:186-196` | medium | none |
| L-14 | Responses | A response that fails its schema is answered 422 `validation.invalid_field` with the internal field path and is not logged; a code comment promises 500. | `src/shared/http/error-handler.ts:39-41`, `:51-64`; `src/modules/wallet/api/wallet.schemas.ts:79-83` | medium | PR #244, #245 |
| L-15 | Documents | Object removal is best effort and silent; `retention_until` is never read and no purge job exists; the private bucket is versioned, so a removal may leave the earlier version (derived). | `src/modules/intake/application/upload-case-document.service.ts:38-48`, `:65-80`; `prisma/schema/schema.prisma:102`; `src/infrastructure/storage/ensure-minio-bucket.ts:27` | medium | none |
| L-16 | Uploads | Uploads are buffered twice in memory (about 200 MB at the cap), with no concurrency cap and no memory limit on the api container; staff downloads read the whole object. | `src/modules/intake/application/upload-case-document.service.ts:101-104`; `src/modules/offering/application/upload-offering-document.service.ts:77-102`; `src/modules/intake/api/intake-operations.router.ts:280-284` | medium | none |
| L-17 | Logging | `x-trace-id` is accepted without validation and reaches responses, logs, audit rows and, unmasked, the dead-letter alert message. | `src/shared/http/request-context.ts:8-9`; `src/shared/jobs/dead-letter-consumer.ts:14-20`; `src/shared/jobs/dead-letter-alert-webhook.ts:45` | low | #217 |
| L-18 | Better Auth mount | No body size limit on `/api/auth/*` (library, derived); every `/api/auth/*` request, reads included, shares one 10-per-minute-per-IP bucket with the device-auth, invitation-accept and staff WebAuthn routes. | `src/app.ts:568-575`; `src/shared/http/rate-limit.ts:23-27`, `:35` | medium | none |
| L-19 | Fresh authentication | `/link-social` is outside the fresh-authentication list; the Better Auth hook skips staff sessions; the window is 5 minutes where the record says 15. | `src/modules/auth/infrastructure/customer/better-auth-fresh-authentication.plugin.ts:12-17`, `:71`; `src/modules/auth/domain/fresh-authentication.ts:10` | medium | none |
| L-20 | Authorization | The customer population check is a per-router convention missing from four mounted customer routers (intake, own-session, login-method and device-replacement) and from the signing-request router, which main does not mount; on the reservation routes idempotency runs before it. | [architecture.md](architecture.md) section 5.4; `src/modules/offering/api/offering.router.ts:61-65` | low | none |
| L-21 | Rate limiting | `INCR` and `EXPIRE` are separate calls; a failure of the second leaves a counter with no expiry (derived). | `src/infrastructure/rate-limit/redis-rate-limit-store.ts:14-17` | low | none |
| L-22 | Configuration | `NODE_ENV` defaults to `development` and every production refinement is skipped when it is unset; staging does not pin it; placeholder secrets from `.env.example` pass validation; the staging relaxation `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` ends in a database error on the decision step. | `src/config/environment.ts:8`, `:585-592`; `.env.example:19`, `:108`; conflict register C-013 | medium | #214; PR #238 |
| L-23 | Audit | `audit.audit_log` has no immutability trigger and one path rewrites a row; `ip_address_hash` and `user_agent_hash` are never written; no read is audited. | `src/modules/identity/repository/prisma-kyc.repository.ts:871-878`; `prisma/schema/schema.prisma:1073-1074` | medium | none |
| L-24 | Audit | A dead-letter replay leaves one log line and no audit row. | `src/cli/replay-dead-letter-job.ts`; `src/shared/jobs/dead-letter-replay.ts` | low | #209; PR #233 |
| L-25 | Deployment | The api and worker containers run as `root`; the runtime install keeps dev tooling (`devOptional` packages); the staging api publishes host port 3000 and the mail catcher port 1080 on all interfaces (not verified: host firewall); the api holds the MinIO root credential. | `Dockerfile:31-48`; `package-lock.json`; `docker-compose.staging.yml:29`, `:120`, `:43` | medium | none |
| L-26 | Self-custody | The api needs `CHAIN_OPERATOR_PRIVATE_KEY` in its environment for the escrow gate although it never signs; `CHAIN_NETWORK=base` is accepted in any environment. | `src/infrastructure/blockchain/settlement-bundle.ts:28`; `src/modules/offering/repository/offering-repository-options.ts:25`; `src/config/environment.ts:289-292`; `docker-compose.staging.yml:205` | medium | C-008 |
| L-27 | Money | The staff readiness policy sums EUR with floating-point `Number`. | `src/modules/intake/domain/operations-readiness.policy.ts:125`, `:132`, `:133`, `:412` | low | #122 (closed) |
| L-28 | Validation | Header and query inputs of the intake document routes are not schema-validated; `NaN` is passed to a Prisma `where` (not exercised). | `src/modules/intake/api/intake-operations.router.ts:230-234`, `:263-266`; `src/modules/intake/application/upload-case-document.service.ts:93` | low | none |
| L-29 | Availability | The S3 clients are built without timeouts and the database pools without a connection timeout; with an exhausted pool `/health/ready` waits instead of answering 503 (derived from library defaults). | `src/server.ts:531-538`, `:543`; `src/infrastructure/storage/minio-disclosure-document.store.ts:35-44`; `src/infrastructure/database/prisma.ts:6` | low | none |
| L-30 | Headers | `Cache-Control` is set per handler; 14 of 28 router files set none, among them customer intake and staff account search. | section 7 | low | none |
| L-31 | Origins | `AUTH_TRUSTED_ORIGINS` defaults to `http://localhost:3000` with no production refinement. | `src/config/environment.ts:135-138` | low | none |
| L-32 | CSRF | No CSRF token on `/v1` or `/internal/v1`; cookie sessions rely on `SameSite=Lax`, and the cookie's parent `Domain` reaches sibling subdomains (derived). | `src/modules/auth/infrastructure/shared/better-auth.factory.ts:461-466`, `:480`; section 6.4 | low | none |
| L-33 | Rate limiting | The baseline limiter is mounted on the whole `/v1/offerings` prefix before authentication and keyed by IP, so authenticated reservation, reconfirmation, detail and download requests are also counted per address; callers that share an address share one 300-per-minute bucket, and with `TRUST_PROXY` unset behind a proxy that is every caller. Reproduced with the repository's limiter and a stand-in store. | `src/app.ts:591-595`; `src/shared/http/rate-limit.ts:68-73`; section 3.2 | medium | none |

## 20. Conflicts with the design record

Where the code and the record disagree and the record is not changed here. "Register" names a conflict register entry (`00-Governance/MIGRATION/CONFLICT_REGISTER.md` of the design repository; read from the design repository's `origin/main` at `eadf224`, 2026-11-18, which holds C-001 to C-024; the checkout's local `main` branch of that repository stops at C-008).

| Topic | Record | Code | Register |
| --- | --- | --- | --- |
| Malware scanning | AD-130 and `INPUT_VALIDATION.md`: allowlist, size cap and content-sniffing, and no malware scanning | ClamAV scan on every upload; content-sniffing only for room photos | C-014 |
| Idempotency key shape and retention | AD-147: one shared table with a key, endpoint, body hash, response and an expiry | the same shape, so account and path are not in the key; expiry stored, not enforced | C-006 (open): its item 3 records, from reading the code, the key shape without the account or the path identifiers, the unenforced `expires_at` and the replay of stored error responses, and puts the account-in-key and the expiry questions to the founder; it does not record the missing in-flight lock (concurrent first requests) |
| Audit writes | AD-148: automatic, through a shared wrapper | per-repository `auditLog.create` | none |
| Role checks | AD-153: declared roles, checked by shared middleware, fail closed | guards listed by hand per router | none |
| Rate-limit tiers | `RATE_LIMITING.md`, AD-129, AD-176: money-movement and `Idempotency-Key` writes in the tightened tier | tightened tier on authentication surfaces only | none |
| Fresh-authentication window and actions | `04-Engineering/IDENTITY-AND-SECURITY/SESSION_LIFETIME_AND_REVOCATION.md:45`, `:57` (design repository): 15 minutes; linking or removing a login method is sensitive. The record gives 15 minutes in four places and 5 minutes in `04-Engineering/IDENTITY-AND-SECURITY/TRANSACTION_AUTHORIZATION_AND_SCA.md:28`, `:39` | 5 minutes; unlink is covered, link is not | C-010 (window: its item 4 and question 11, open). Whether linking a login method needs fresh authentication is in no register entry found |
| Signing keys | AD-247: VistaBlox holds no signing key anywhere | the worker signs with a platform-held key | C-008 |
| Callback routes | AD-066: `/provider/v1` | `/webhooks/didit`, `/webhooks/coinbase-onramp` | C-015 (route kept by AD-289) |
| Staging relaxations | AD-015, AD-209: two distinct reviewers and a fresh Didit check | two `APP_ENV=staging` switches | C-013 |
| Direct connection string | `SECRETS_IN_DEPLOYMENT.md`: scoped to the migration step | `DIRECT_DATABASE_URL` is passed to the api and the worker in staging | none |
| Error `type` URI | `ERROR_HANDLING.md` example: `https://api.vistablox.eu/errors/validation` | `https://api.vistablox.io/errors/<code>` | none |

## 21. Not verified

- The contents of `.env.staging` and any production configuration: whether Redis, ClamAV, TRUST_PROXY, SMTP, Coinbase and the chain settings are set anywhere; the host firewall; the reverse proxy's idle timeout.
- Behaviour on PostgreSQL 18; no database was run in this pass.
- Real Coinbase and real clamd 1.4.6 behaviour: the clamd answer to the malformed command (taken from #205 and #225), a real signed Coinbase webhook, Coinbase's EUR and Base support.
- Better Auth behaviour at runtime: its origin check, its disabled rate limiter, its body handling and its endpoint set were read from the installed 1.7.2 and better-call 1.4.0 sources; no request was sent to a running instance. Library behaviour for `helmet`, `cors`, `body-parser`, `pino-http` and `express` was observed in scratch processes with the locked versions, outside the repository.
- The idempotency and error-handler results come from running the repository's own source files against a stand-in store and a stand-in route, not against `createApp` or a database.
- The mobile client: key scheme for `Idempotency-Key`, DPoP implementation, whether the shared wire contract in `docs/plans/device-bound-auth-backend.md` section 3 is byte-identical with the mobile plan.
- The npm audit result (section 18) is the registry's answer on 2026-11-20 only. Advisory texts were not read in full, and whether a condition applies to the plugins and options this repository enables was not checked.
- `DATA_ENCRYPTION.md` and `SECRETS_MANAGEMENT.md` in the design record were not read for this chapter.
