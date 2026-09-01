# VistaBlox API

API-only backend for VistaBlox. This repository is being implemented from the architecture record in `../Docs/Backend`; when code and those documents disagree, the current design record and `03-Database/CORE_TABLES.md` take precedence.

## Implemented foundation

- Express 5 and TypeScript API runtime
- Zod validation for requests, responses, environment variables, and errors
- stable error envelope with a trace ID
- structured, redacted JSON logging
- liveness and database-readiness endpoints
- first layered product slice: public offering teasers at `GET /v1/offerings`
- authenticated full offering detail at `GET /v1/offerings/:offering_id`, including the current disclosure pack, material-change log, raise progress, and account-specific investment readiness
- authenticated disclosure downloads streamed through the API from private MinIO storage; object references and presigned storage URLs are never exposed
- self-hosted Better Auth core for email/password and optional Google login
- verified-email delivery through provider-neutral SMTP
- SMTP password-reset delivery with post-reset session revocation
- HIBP k-anonymity breached-password screening on password creation and changes
- stable Better Auth identity to VistaBlox `account_id` provisioning
- authenticated account-context middleware with fail-closed account restrictions
- mandatory per-session WebAuthn for staff/partner internal API access
- direct SimpleWebAuthn registration/authentication with multiple credential support
- one-time, session-bound WebAuthn challenges and success/failure audit records
- WebAuthn-protected, invitation-only staff/partner provisioning with scoped roles
- 72-hour single-use staff invitation tokens stored only as SHA-256 hashes
- idempotent Better Auth audit hooks for login, session, and password events
- privacy-preserving failed-login correlation without storing raw login identifiers
- WebAuthn-protected staff recovery that revokes sessions and credentials before reset delivery
- immediate staff/partner offboarding with Better Auth login blocking, role revocation, and audit logging
- Didit v3 hosted individual-KYC session creation with opaque account correlation
- HMAC-SHA256 V2 authenticated Didit webhooks with timestamp replay protection and event idempotency
- webhook-then-fetch KYC decisions covering ID, liveness, face match, AML, age, and EU/EEA jurisdiction policy
- separate hosted Didit proof-of-address workflow with residence matching and three-month document freshness
- privacy-minimized KYC persistence that excludes provider payloads, document data, biometrics, and addresses
- authenticated investor profile aggregate at `GET /v1/investor-profile`
- cursor-paginated investor reservation history and current portfolio subresources
- Redis/Valkey-backed, 24-hour protected cache for Didit-verified display names
- KYC/proof-of-address-gated owner intake at `POST /v1/origination-cases`
- owner-scoped origination case list/detail reads with opaque cursor pagination
- append-only initial submission revisions with mandatory evidence and audit logging
- founder-only origination review surface secured by active `admin_operations` assignment
- structured information requests, owner resubmission as immutable revision N+1, and atomic request resolution
- founder approval/rejection with review record, IPO terms, lifecycle transition, and audit logging
- Redis/Valkey-backed general-purpose rate limiting across `/v1`, `/internal/v1`, and Better Auth's endpoints: a generous baseline tier keyed by `account_id` (or caller IP when unauthenticated), and a stricter tightened tier on fresh-auth attempts (Better Auth sign-in/sign-up/password-reset, staff WebAuthn ceremonies, staff invitation acceptance); fails open with a logged warning if the rate-limit cache is unavailable
- a dedicated `pg-boss` worker process (`npm run worker:dev` / `npm run worker:start`) running the `case_timers`/`maintenance` scheduled jobs: applicant response-window reminders and automatic expiry once `due_at` passes, KYC renewal reminders and the automatic `requires_renewal` transition once `renewal_due_at` passes, and an hourly sweep deleting expired `oidc_model_instances` rows (Postgres has no native TTL, so without it the OIDC store would grow unboundedly)
- customer TOTP enrollment and verification at `POST /v1/auth/totp/enroll` and `POST /v1/auth/totp/verify`, hand-rolled with `otplib` rather than Better Auth's own two-factor plugin (matching the `@simplewebauthn` precedent already set for staff WebAuthn); one-time backup codes are generated at enrollment, HMAC-hashed, and marked consumed on use
- a general-purpose `Idempotency-Key` middleware (`createIdempotencyMiddleware`, `src/shared/http/idempotency.ts`) against the shared `audit.idempotency_keys` table: a replayed key with a matching request body returns the cached response without re-running the handler, a matching key with a different body is a `409`, and a lookup failure before the handler runs fails closed (`503`) while a caching failure after it fails open — the response the caller is waiting for is never held hostage by a bookkeeping write
- customer session/device self-service at `GET /v1/auth/sessions` and `POST /v1/auth/sessions/:session_id/revoke`: Better Auth's session-lifecycle hooks now populate a richer `account.sessions` mirror (channel, best-effort device label, auth method, timestamps) alongside the audit trail they already fed, and revoking a listed session calls Better Auth's own `revoke-session` endpoint server-side rather than exposing the raw session token to the client; the same two endpoints now also list and revoke native-client OIDC grants (see below), merged into one list per `SESSION_MODEL.md`
- native-client Authorization Code + PKCE via `oidc-provider` (`AD-169`), mounted at `/oidc`: a single first-party VistaBlox client (`vistablox-native`), PKCE required (oidc-provider's own default for a public client), rotating refresh tokens with built-in reuse detection, and credential/MFA verification delegated to Better Auth rather than a second credential store — the JSON-only interaction endpoints at `/oidc/interaction/:uid` check for an existing Better Auth session and auto-confirm consent for the single first-party client instead of rendering a login/consent page; grant/token state persists through its own Postgres adapter (`oidc_model_instances`, `src/modules/auth/infrastructure/postgres-oidc-adapter.ts`), the same storage pattern Better Auth uses, not an in-memory store; the Express API itself validates native bearer access tokens via oidc-provider's own `AccessToken` model, so `/v1` routes accept either the web session cookie or a native bearer token through the same `requireAuthentication` middleware. As with any OIDC provider, the native client must send `prompt=consent` on the authorization request to receive a refresh token — without it `offline_access` is silently dropped and only a short-lived access token comes back (oidc-provider's own spec-mandated behavior, not configurable here)
- Prisma 7 client using the PostgreSQL driver adapter
- all eight documented PostgreSQL schemas and their current tables, relations, indexes, and explicit check constraints
- Vitest API and domain tests
- dependency boundary checks for the documented `router -> schema -> application service -> domain policy -> repository` layering

Native-client OIDC has been exercised end to end — full PKCE authorization, the two-step login-then-consent interaction, code exchange, resource-server bearer verification, refresh-token rotation, and reuse-detection-triggered grant revocation all confirmed working against the real `oidc-provider` library and this repo's own interaction router — but that run used an in-memory stand-in for the adapter's Postgres queries, since this environment cannot open a raw TCP connection to Postgres. The adapter's actual SQL (upsert/find/consume/expiry filtering, the cross-model `revokeByGrantId` delete, and the partial unique indexes) was separately validated by running it directly against a live Postgres database. Neither run exercised a real native app or a real reverse-proxied deployment; do a real end-to-end pass (real app, real redirect URIs, real Postgres, `provider.proxy`/`trust proxy` configured if a reverse proxy sits in front) before depending on this in production. `OIDC_NATIVE_REDIRECT_URIS` is a placeholder until the actual native app's custom URI scheme (and desktop loopback redirect, if applicable) is known. Bulk revocation ("all web sessions", "all native grants", or "all continuity for the account") is not built; `/v1/auth/sessions` currently only revokes one session or grant at a time, matching what Task 4 shipped — SESSION_MODEL.md calls for the bulk case too. Enrolling/verifying a TOTP factor is available now, but the sensitive-action fresh-auth challenge that AD-109 says should require it has no current caller — no customer-facing action is yet marked sensitive enough to gate, so `VerifyTotpService` is a ready primitive without a mounted gate in front of it. The idempotency middleware is similarly unmounted: AD-057's high-risk-write list (reservation funding, refunds, payouts, and the like) is entirely unbuilt money-movement/settlement work, so there is no current endpoint that legitimately qualifies for it yet — the mechanism is ready for whichever endpoint reaches that list first. Rate-limit tier thresholds are a fixed starting point (`src/shared/http/rate-limit.ts`) pending real production traffic to tune against, per `RATE_LIMITING.md`. Better Auth login success/failure, session creation/revocation, password change/reset, WebAuthn outcomes, staff invitation actions, recovery, and offboarding now feed the unified audit trail. A WebAuthn-verified administrator provisions staff and partner identities through single-use email invitations; after acceptance, the invited user signs in and enrolls a first WebAuthn credential, while adding any later credential requires an already WebAuthn-verified session. That same protected admin surface can initiate a staff reset or immediately offboard an identity; the code intentionally does not enable Better Auth's impersonation-capable admin plugin. Operations-review decision display, cross-validation of declared identity data, and asynchronous webhook processing remain follow-on KYC work. Information-request due dates currently exclude Saturdays and Sundays; a jurisdiction-aware holiday calendar remains future work.

Reservation creation remains deliberately closed. The authenticated offering detail returns `funding_rail_unavailable` in its reservation preflight because the documented Stripe EUR-to-EURC/Base flow is not currently supported by Stripe Onramp, and the architecture does not define expiry/release semantics for an unfunded capacity hold. See [`docs/investor-offering.md`](docs/investor-offering.md) for the contract and dated provider evidence.

## Local setup

Requirements: Node.js 22+, npm, and PostgreSQL 16+ (or a Neon development branch).

```bash
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate:dev
npm run dev
```

`DATABASE_URL` is the pooled runtime connection. `DIRECT_DATABASE_URL` must be the non-pooled connection used by Prisma migrations.

Didit baseline KYC remains disabled unless the required `DIDIT_*` values in `.env.example` are configured together. `DIDIT_POA_WORKFLOW_ID` independently enables the owner-only hosted address workflow. `PROFILE_CACHE_URL` enables the short-lived Didit-verified display-name cache; the profile route remains available and omits names when the cache is absent or unavailable. The provider webhook destination is `/webhooks/didit`; the callback URL is the frontend destination Didit uses after either hosted verification flow. See [`docs/didit-kyc.md`](docs/didit-kyc.md) and [`docs/investor-profile.md`](docs/investor-profile.md) for the reviewed workflows and data boundaries.

`RATE_LIMIT_CACHE_URL` enables the general-purpose `/v1` rate limiter (it may point at the same Redis/Valkey deployment as `PROFILE_CACHE_URL`); requests are allowed through unmetered, not blocked, while it is absent or unavailable.

Native-client OIDC always mounts (there is no feature flag), so `OIDC_JWKS` and `OIDC_NATIVE_REDIRECT_URIS` are required. `OIDC_JWKS` is a JSON Web Key Set string used to sign ID tokens and must be generated per environment — it is private key material, so unlike other configuration there is deliberately no shared default anywhere, matching `BETTER_AUTH_SECRET`. Generate one with:

```bash
node -e "const {generateKeyPairSync}=require('node:crypto');const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk=privateKey.export({format:'jwk'});jwk.kid=require('node:crypto').randomUUID();jwk.use='sig';jwk.alg='RS256';console.log(JSON.stringify({keys:[jwk]}))"
```

`OIDC_NATIVE_REDIRECT_URIS` is a comma-separated allowlist of the native app's registered redirect URIs (a custom URI scheme for mobile, a loopback address for desktop per RFC 8252); `.env.example` ships a placeholder that must be replaced with the real app's before this is usable end to end.

The scheduled-job worker is a separate process from the API and must be started alongside it for reminders/expiry to run: `npm run worker:dev` locally, `npm run worker:start` against a build. It shares `DATABASE_URL`/SMTP configuration with the API; it also loads the same environment schema as the API (so `OIDC_JWKS`/`OIDC_NATIVE_REDIRECT_URIS` must be set for it to start even though the worker itself never uses them, the same way it already requires but never uses `BETTER_AUTH_SECRET`), but needs no worker-specific environment variables of its own.

## Docker

`docker-compose.yml` runs the whole stack — Postgres, Valkey, the API, and the worker — plus Mailpit as a local SMTP catcher (`http://localhost:8025`) so `docker compose up` works without real SMTP credentials.

```bash
cp .env.example .env
# fill in BETTER_AUTH_SECRET, OIDC_JWKS (see the generator above), and
# OIDC_NATIVE_REDIRECT_URIS at minimum
docker compose up --build
```

The API is then at `http://localhost:3000`. `migrate` is a one-shot service that runs `prisma migrate deploy` before `api`/`worker` start (`depends_on: condition: service_completed_successfully`); rerunning `docker compose up` re-runs it, which is a no-op once migrations are already applied.

`Dockerfile` is a multi-stage build with four targets (`docker build --target=<name>`): `deps`/`build` are intermediate stages that install full dependencies and compile (`prisma generate` then `tsc`); `migrate` reuses `build` since `prisma migrate deploy` needs the Prisma CLI (a devDependency) and the schema/migrations directory; `api` and `worker` copy only the compiled `dist/` output and production dependencies onto a fresh base — neither carries the Prisma CLI, TypeScript, or the schema/migrations directory; `oidc-provider`'s generator (`@prisma/adapter-pg`, no native query-engine binary) means plain `node:22-alpine` works with no glibc/OpenSSL matching concerns.

Compose overrides `DATABASE_URL`, `PROFILE_CACHE_URL`, `RATE_LIMIT_CACHE_URL`, `BETTER_AUTH_URL`, and the `SMTP_*` values to point at the container network (`postgres`, `cache`, `mailpit`) regardless of what `.env` has for them; everything else — `BETTER_AUTH_SECRET`, `OIDC_JWKS`, `OIDC_NATIVE_REDIRECT_URIS`, and the optional `GOOGLE_*`/`DIDIT_*` toggles — comes from `.env` via `env_file`.

This has been validated end to end in a real Docker daemon: a clean build of all four targets, `prisma migrate deploy` applying the repository's entire migration history (all 15 migrations, from the initial schema through `oidc_provider_store`) against a fresh Postgres container, and the running `api`/`worker` containers passing their healthchecks and serving real requests (including the OIDC discovery document) against the containerized Postgres/Redis. One real finding from that run, now fixed: Postgres 18's official image expects its volume mounted at `/var/lib/postgresql`, not `/var/lib/postgresql/data` (`docker-compose.yml` already reflects this); pg-boss v12 requires a queue to exist (`createQueue`, idempotent) before it can be scheduled or worked, which `worker.ts` now does on every start.

## Commands

```bash
npm run check          # type checking, architecture rules, tests
npm run build          # production TypeScript build
npm run worker:dev     # run the pg-boss scheduled-job worker (watch mode)
npm run worker:start   # run the built worker
npm run db:validate    # validate Prisma schema
npm run db:generate    # regenerate Prisma client
npm run db:migrate:dev # create/apply a development migration
npm run db:migrate:deploy
docker compose up --build   # run the full stack (Postgres, Valkey, API, worker, Mailpit) in containers
docker compose down -v      # stop and remove containers + the Postgres volume
```

## HTTP surface currently available

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health/live` | Process liveness; does not query dependencies |
| `GET` | `/health/ready` | Readiness; verifies PostgreSQL connectivity |
| `GET/POST` | `/api/auth/*` | Better Auth browser authentication endpoints |
| `GET/POST` | `/oidc/*` | `oidc-provider`'s own endpoints: discovery, `/oidc/auth`, `/oidc/token`, `/oidc/token/revocation`, `/oidc/jwks` |
| `GET` | `/oidc/interaction/:uid` | Resolve a login or consent prompt (delegates to the caller's Better Auth session; JSON, no HTML) |
| `POST` | `/oidc/interaction/:uid/abort` | Cancel an in-progress interaction |
| `POST` | `/internal/v1/auth/webauthn/registration/options` | Begin staff credential enrollment |
| `POST` | `/internal/v1/auth/webauthn/registration/verify` | Verify and store a staff credential; marks the session MFA-complete |
| `POST` | `/internal/v1/auth/webauthn/authentication/options` | Begin mandatory staff session MFA |
| `POST` | `/internal/v1/auth/webauthn/authentication/verify` | Verify a staff assertion and mark the session MFA-complete |
| `POST` | `/internal/v1/auth/staff-invitations` | Issue a role-scoped staff/partner invitation; requires admin role and WebAuthn |
| `POST` | `/v1/auth/staff-invitations/accept` | Accept an emailed invitation and set the initial password |
| `POST` | `/internal/v1/auth/staff-accounts/:account_id/recovery` | Revoke staff sessions/WebAuthn credentials and email a password reset; requires another admin and WebAuthn |
| `POST` | `/internal/v1/auth/staff-accounts/:account_id/offboard` | Disable staff login and revoke sessions, roles, and credentials; requires another admin and WebAuthn |
| `GET` | `/v1/offerings?limit=20&after=...` | Cursor-paginated public offering teasers |
| `GET` | `/v1/offerings/:offering_id` | Authenticated customer-only full offering detail, disclosure metadata, progress, and reservation-readiness blockers |
| `GET` | `/v1/offerings/:offering_id/documents/:document_id/download` | Stream an authorized current or reservation-linked historical disclosure document from private storage |
| `GET` | `/v1/investor-profile` | Read the authenticated customer's cross-domain investor profile aggregate |
| `GET` | `/v1/investor-profile/reservations?limit=20&after=...` | Read account-scoped reservation history with the latest capital state |
| `GET` | `/v1/investor-profile/positions?limit=20&after=...` | Read active and internally-settling portfolio positions |
| `POST` | `/v1/auth/totp/enroll` | Enroll (or re-enroll) a customer TOTP factor; returns the `otpauth://` URI, secret, and one-time backup codes |
| `POST` | `/v1/auth/totp/verify` | Verify a customer TOTP code or one-time backup code |
| `GET` | `/v1/auth/sessions` | List the authenticated customer's own web sessions and native OIDC grants as one list |
| `POST` | `/v1/auth/sessions/:session_id/revoke` | Revoke one of the authenticated customer's own sessions or native grants |
| `GET` | `/v1/kyc` | Read the authenticated customer's local eligibility status and renewal dates |
| `POST` | `/v1/kyc/sessions` | Create one hosted Didit individual-KYC session for an eligible customer account |
| `POST` | `/v1/kyc/proof-of-address/sessions` | Create an owner-only hosted Didit address-verification session after baseline KYC |
| `POST` | `/webhooks/didit` | Authenticate and idempotently process Didit status/data webhooks |
| `POST` | `/v1/origination-cases` | Create an authenticated, eligibility-gated draft owner intake |
| `GET` | `/v1/origination-cases?limit=20&after=...` | List the authenticated owner's cases |
| `GET` | `/v1/origination-cases/:case_id` | Read one owner-scoped case; out-of-scope IDs return `404` |
| `POST` | `/v1/origination-cases/:case_id/submit` | Submit a draft as immutable revision 1 with required evidence |
| `GET` | `/v1/origination-cases/:case_id/information-requests` | List the owner's published request history |
| `POST` | `/v1/origination-cases/:case_id/information-requests/:request_id/respond` | Answer the current request with immutable revision N+1 |
| `GET` | `/internal/v1/origination-cases?stage=submitted&limit=20&after=...` | WebAuthn-protected founder operations case queue |
| `GET` | `/internal/v1/origination-cases/:case_id` | Founder review detail, current revision, evidence, and request history |
| `POST` | `/internal/v1/origination-cases/:case_id/information-requests` | Publish an owner request and start the configured response window |
| `POST` | `/internal/v1/origination-cases/:case_id/decisions` | Approve with IPO terms or reject a submitted case |

All errors follow the documented envelope: `type`, `code`, `title`, `status`, `detail`, `trace_id`, and optional `field_errors`.

## Database notes

The Prisma schema lives at `prisma/schema.prisma`; reviewed SQL migrations are under `prisma/migrations`. Check constraints and append-only revision enforcement that Prisma cannot express are maintained directly in migration SQL. Better Auth owns its four `public.auth_*` tables through its PostgreSQL adapter; `oidc-provider` likewise owns `public.oidc_model_instances` through its own adapter (`src/modules/auth/infrastructure/postgres-oidc-adapter.ts`) — product code deliberately does not model or query either through Prisma. The runtime uses the generated client in `src/generated/prisma`, which is deliberately excluded from Git and regenerated during setup/build.
