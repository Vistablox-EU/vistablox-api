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
- staff/partner roster, incremental role grants, and single-role revocation at `GET /internal/v1/auth/staff-accounts`, `POST /internal/v1/auth/staff-accounts/:account_id/roles`, and `POST /internal/v1/auth/staff-accounts/:account_id/roles/:assignment_id/revoke` — the RBAC-administration gaps the invitation/offboarding pair above didn't cover: discovering existing `account_id`s and their role assignments at all (the roster's per-assignment `revoked_at` means it doubles as the role-history view, rather than needing a separate query), extending an already-onboarded staff member with an additional role without re-running the brand-new-identity invitation ceremony (`assertEmailAvailable` still blocks that ceremony for an existing identity, by design), and revoking one specific role without the full session/WebAuthn/status teardown `/offboard` performs. All three reuse the exact `admin_operations` + staff-WebAuthn gate and the same self-service block already established by recovery/offboarding — granting or revoking your own role is refused exactly like recovering or offboarding yourself is, so one compromised or careless admin session can't self-escalate or self-lock-out the roster. Granting a role the account already actively holds is a `409`, not a silent duplicate row. The roster is deliberately unpaginated, unlike every customer-activity list elsewhere in this API: staff/partner headcount is organizationally bounded, not a growth metric
- Didit v3 hosted individual-KYC session creation with opaque account correlation
- HMAC-SHA256 V2 authenticated Didit webhooks with timestamp replay protection and event idempotency
- webhook-then-fetch KYC decisions covering ID, liveness, face match, AML, age, and EU/EEA jurisdiction policy
- separate hosted Didit proof-of-address workflow with residence matching and three-month document freshness
- risk-aware baseline-KYC renewal intervals per `KYC_WORKFLOW.md`'s Renewal Policy: 24 months for a low-risk account, 12 for one that has ever resolved to `kyc_manual_review` (`identity.kyc_eligibility.ever_required_manual_review`, latched permanently the first time that happens — a past manual-review outcome is a phase-1 risk marker, not a rolling window — and still true if a later decision clears the account to `kyc_verified`); the existing renewal-reminder/expiry worker needed no changes since it already just reads whatever `renewal_due_at` was last computed
- privacy-minimized KYC persistence that excludes provider payloads, document data, biometrics, and addresses
- WebAuthn-protected operations decision display at `GET /internal/v1/kyc-accounts/:account_id`: the same `admin_operations` + staff-WebAuthn gate as founder origination review, reading the same already-persisted, already privacy-minimized eligibility record — never the raw Didit artifacts, which were never persisted in the first place. Surfaces the operational detail the customer's own `GET /v1/kyc` intentionally omits (`operational_substatus`, the Didit provider reference, declared residence/tax-residence countries, `ever_required_manual_review`) so a reviewer can actually see why an account is stuck in `pending_manual_review` or similar and why its renewal clock is set the way it is, closing the first of `docs/didit-kyc.md`'s follow-on-work gaps; a missing record reports `404` rather than a misleading default, since an arbitrary staff-supplied `account_id` might just be a typo
- authenticated investor profile aggregate at `GET /v1/investor-profile`
- cursor-paginated investor reservation history and current portfolio subresources
- Redis/Valkey-backed, 24-hour protected cache for Didit-verified display names
- KYC/proof-of-address-gated owner intake at `POST /v1/origination-cases`
- owner-scoped origination case list/detail reads with opaque cursor pagination
- append-only initial submission revisions with mandatory evidence and audit logging
- founder-only origination review surface secured by active `admin_operations` assignment
- structured information requests, owner resubmission as immutable revision N+1, and atomic request resolution
- founder approval/rejection with review record, IPO terms, lifecycle transition, and audit logging
- founder-initiated case closure (withdrawal or a late-stage reject) at `POST /internal/v1/origination-cases/:case_id/close`, distinct from the submitted-stage initial review above: `PERMISSION_MATRIX.md`'s "Reject, withdraw, or expire a case, at any stage" row, matched against `REAL_ESTATE_INTAKE_LIFECYCLE.md`'s state diagram rather than that row's own looser wording — withdrawal is reachable from `draft`/`submitted`/`waiting_on_applicant`/`pre_offering_open` (conceptually the applicant's own choice per `AD-104`, but recorded by the founder, since the applicant-facing lane stays founder-mediated in phase 1), a late-stage reject only from `pre_offering_open` ("ipo_period ends underfunded, founder closes the case"). Automatic expiry (`waiting_on_applicant` with no response inside the SLA) already existed before this and needed no changes
- case discussion threads on the two human-postable lanes `REAL_ESTATE_INTAKE_LIFECYCLE.md`'s Thread Rules fix (`AD-244`'s 2026-08-29 update, which removed the earlier legal/appraisal workstream lanes entirely — no partner organizations to hold them in phase 1): `internal_case` (founder-only, matching `PERMISSION_MATRIX.md`'s "Post in internal case thread") and `applicant` (owner and founder, matching "Post in applicant thread"); the third lane, `system_timeline`, is system-generated and append-only per those same rules, so nothing here writes to it. The owner-facing routes are lane-implicit — `applicant` is the only lane the owner can ever reach, so there's no `lane` parameter to get wrong; the operations-facing ones take an explicit `lane`. A thread is created lazily on its first message rather than provisioned per case up front; `case_threads` gained a `(case_id, lane)` uniqueness constraint it was missing since the tables were first migrated, to actually guarantee the "same fixed lane set" rule now that something writes to them
- Redis/Valkey-backed general-purpose rate limiting across `/v1`, `/internal/v1`, and Better Auth's endpoints: a generous baseline tier keyed by `account_id` (or caller IP when unauthenticated), and a stricter tightened tier on fresh-auth attempts (Better Auth sign-in/sign-up/password-reset, staff WebAuthn ceremonies, staff invitation acceptance); fails open with a logged warning if the rate-limit cache is unavailable
- a dedicated `pg-boss` worker process (`npm run worker:dev` / `npm run worker:start`) running the `case_timers`/`maintenance` scheduled jobs: applicant response-window reminders and automatic expiry once `due_at` passes, KYC renewal reminders and the automatic `requires_renewal` transition once `renewal_due_at` passes, and an hourly sweep deleting expired `oidc_model_instances` rows (Postgres has no native TTL, so without it the OIDC store would grow unboundedly)
- the first exercised cross-domain `pg-boss` handoff (`AD-145`, "never a direct synchronous call"): a shared `enqueueTransactionalJob` helper (`src/shared/jobs/enqueue-job.ts`) is now the one path every cross-domain job send goes through — it auto-injects `trace_id` (`AD-152`, so no call site threads it through manually) and binds the send to the caller's own Prisma transaction via `pg-boss`'s per-call `db` adapter, so the job is durably queued in the exact same transaction as the state change that created it, never a separate step that could fail independently of it. `case_timers.pre_offering_open_handoff` is its first consumer: approving an origination case (`pre_offering_open`) enqueues a job that opens the `Piv`/`Offering` shell — `minimum_raise_eur` and `target_raise_eur` both set to the founder's own `ipo_value_eur`, `AD-238`/`AD-245`'s hard floor having collapsed the two into one number — that the property needs to actually become the browsable, reservation-ready listing `REAL_ESTATE_INTAKE_LIFECYCLE.md`'s "Property pre-offering" describes; before this, an approved case could never actually appear at `GET /v1/offerings`, since nothing wrote to that table at all. Idempotent by construction, not by an extra guard: `pivs.property_id`'s own uniqueness means replaying an already-processed job (a pg-boss retry, or the worker fetching the same job twice) is a safe no-op that returns the existing ids rather than a second row. This closes only the bridge from approval to first visibility — `PIV` incorporation, appraisal, corridor clearance/`AIF`-gating, and the later locked-terms `final_offering_published_at` publication described in the same document are separate, still-unbuilt follow-on work
- customer TOTP enrollment and verification at `POST /v1/auth/totp/enroll` and `POST /v1/auth/totp/verify`, hand-rolled with `otplib` rather than Better Auth's own two-factor plugin (matching the `@simplewebauthn` precedent already set for staff WebAuthn); one-time backup codes are generated at enrollment, HMAC-hashed, and marked consumed on use
- a general-purpose `Idempotency-Key` middleware (`createIdempotencyMiddleware`, `src/shared/http/idempotency.ts`) against the shared `audit.idempotency_keys` table: a replayed key with a matching request body returns the cached response without re-running the handler, a matching key with a different body is a `409`, and a lookup failure before the handler runs fails closed (`503`) while a caching failure after it fails open — the response the caller is waiting for is never held hostage by a bookkeeping write
- customer session/device self-service at `GET /v1/auth/sessions`, `POST /v1/auth/sessions/:session_id/revoke`, and `POST /v1/auth/sessions/revoke-all`: Better Auth's session-lifecycle hooks now populate a richer `account.sessions` mirror (channel, best-effort device label, auth method, timestamps) alongside the audit trail they already fed, and revoking a listed session calls Better Auth's own `revoke-session` endpoint server-side rather than exposing the raw session token to the client; the same endpoints also list and revoke native-client OIDC grants (see below), merged into one list per `SESSION_MODEL.md`. `revoke-all` covers both stores — every Better Auth session (via Better Auth's own bulk `revoke-sessions` endpoint, which fires the same per-session hooks a single revoke does, so the audit trail and mirror stay correct for free) and every OIDC grant for the account — and, matching "log out everywhere" conventions elsewhere, also ends the caller's own current session/grant rather than leaving a separate "log out everywhere but here" case. Both grant-revocation paths (single and bulk) now write their own `audit.audit_log` entry (`authentication.oidc_grant_revoked`, reusing the same `self_revoke_one`/`self_revoke_all` reason vocabulary Better Auth session revocation already uses) — `oidc-provider`'s own adapter has no lifecycle hook to piggyback on the way Better Auth's session store does, so `RevokeOwnSessionService`/`RevokeAllOwnSessionsService` write it explicitly instead, closing the gap SESSION_MODEL.md's general "a self-revoke action should be recorded in `audit.audit_log`" rule previously left open on the OIDC-grant side
- native-client Authorization Code + PKCE via `oidc-provider` (`AD-169`), mounted at `/oidc`: a single first-party VistaBlox client (`vistablox-native`), PKCE required (oidc-provider's own default for a public client), rotating refresh tokens with built-in reuse detection, and credential/MFA verification delegated to Better Auth rather than a second credential store — the JSON-only interaction endpoints at `/oidc/interaction/:uid` check for an existing Better Auth session and auto-confirm consent for the single first-party client instead of rendering a login/consent page; grant/token state persists through its own Postgres adapter (`oidc_model_instances`, `src/modules/auth/infrastructure/postgres-oidc-adapter.ts`), the same storage pattern Better Auth uses, not an in-memory store; the Express API itself validates native bearer access tokens via oidc-provider's own `AccessToken` model, so `/v1` routes accept either the web session cookie or a native bearer token through the same `requireAuthentication` middleware. As with any OIDC provider, the native client must send `prompt=consent` on the authorization request to receive a refresh token — without it `offline_access` is silently dropped and only a short-lived access token comes back (oidc-provider's own spec-mandated behavior, not configurable here)
- Prisma 7 client using the PostgreSQL driver adapter
- all eight documented PostgreSQL schemas and their current tables, relations, indexes, and explicit check constraints
- Vitest API and domain tests
- dependency boundary checks for the documented `router -> schema -> application service -> domain policy -> repository` layering

Native-client OIDC has been exercised end to end — full PKCE authorization, the two-step login-then-consent interaction, code exchange, resource-server bearer verification, refresh-token rotation, and reuse-detection-triggered grant revocation all confirmed working against the real `oidc-provider` library and this repo's own interaction router — but that run used an in-memory stand-in for the adapter's Postgres queries, since this environment cannot open a raw TCP connection to Postgres. The adapter's actual SQL (upsert/find/consume/expiry filtering, the cross-model `revokeByGrantId` delete, and the partial unique indexes) was separately validated by running it directly against a live Postgres database. Neither run exercised a real native app or a real reverse-proxied deployment; do a real end-to-end pass (real app, real redirect URIs, real Postgres, `provider.proxy`/`trust proxy` configured if a reverse proxy sits in front) before depending on this in production. `OIDC_NATIVE_REDIRECT_URIS` is a placeholder until the actual native app's custom URI scheme (and desktop loopback redirect, if applicable) is known. The `revoke-all` path's grant-side SQL (`revokeAllForAccount`, including the change that made it return the revoked grant IDs for the new audit-write) was smoke-tested live against the same disposable Neon project as every other new query this repo has added, including that it doesn't touch another account's grants; it has no counterpart on the Better Auth side beyond trusting `auth.api.revokeSessions`, which this repo does not re-verify itself. Enrolling/verifying a TOTP factor is available now, but the sensitive-action fresh-auth challenge that AD-109 says should require it has no current caller — no customer-facing action is yet marked sensitive enough to gate, so `VerifyTotpService` is a ready primitive without a mounted gate in front of it. The idempotency middleware is similarly unmounted: AD-057's high-risk-write list (reservation funding, refunds, payouts, and the like) is entirely unbuilt money-movement/settlement work, so there is no current endpoint that legitimately qualifies for it yet — the mechanism is ready for whichever endpoint reaches that list first. Rate-limit tier thresholds are a fixed starting point (`src/shared/http/rate-limit.ts`) pending real production traffic to tune against, per `RATE_LIMITING.md`. Better Auth login success/failure, session creation/revocation, password change/reset, WebAuthn outcomes, staff invitation actions, recovery, and offboarding now feed the unified audit trail. A WebAuthn-verified administrator provisions staff and partner identities through single-use email invitations; after acceptance, the invited user signs in and enrolls a first WebAuthn credential, while adding any later credential requires an already WebAuthn-verified session. That same protected admin surface can initiate a staff reset, immediately offboard an identity, list the full staff/partner roster with role history, grant an existing staff member an additional role, or revoke a single role without a full offboarding; the code intentionally does not enable Better Auth's impersonation-capable admin plugin. Operations-review decision display, cross-validation of declared identity data, and asynchronous webhook processing remain follow-on KYC work. Information-request due dates currently exclude Saturdays and Sundays; a jurisdiction-aware holiday calendar remains future work. The `enqueueTransactionalJob` adapter (a hand-rolled `pg-boss` `IDatabase` implementation forwarding `executeSql` to an existing Prisma transaction's `$queryRawUnsafe`) was confidence-checked against real, unmodified `pg-boss` code — not just this repo's own mocks — using `pg-boss`'s own `pglite` (in-memory Postgres) test adapter as a throwaway, no-network harness; a real job was enqueued and landed correctly in `pgboss.job`. That harness relies on an unexported `pg-boss` internal path and an undeclared transitive dependency, so it was not kept as a committed test, only as a one-time build check — this repo still cannot open a raw TCP connection to Postgres from this environment, the same limitation the OIDC adapter validation above already names, so the `Piv`/`Offering`-creation SQL itself is covered by `tests/investor-offering-repository.integration.test.ts`/`tests/origination-offering-handoff.integration.test.ts` (gated on `TEST_DATABASE_URL`, unexercised here) rather than a live run in this session.

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
| `GET` | `/internal/v1/auth/staff-accounts` | List every staff/partner account and its full role history (active and revoked); requires admin role and WebAuthn |
| `POST` | `/internal/v1/auth/staff-accounts/:account_id/roles` | Grant an additional role to an already-onboarded staff account; requires admin role and WebAuthn |
| `POST` | `/internal/v1/auth/staff-accounts/:account_id/roles/:assignment_id/revoke` | Revoke one role assignment without a full offboarding; requires admin role and WebAuthn |
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
| `POST` | `/v1/auth/sessions/revoke-all` | Revoke every one of the authenticated customer's own sessions and native grants, including the current one |
| `GET` | `/v1/kyc` | Read the authenticated customer's local eligibility status and renewal dates |
| `POST` | `/v1/kyc/sessions` | Create one hosted Didit individual-KYC session for an eligible customer account |
| `POST` | `/v1/kyc/proof-of-address/sessions` | Create an owner-only hosted Didit address-verification session after baseline KYC |
| `POST` | `/webhooks/didit` | Authenticate and idempotently process Didit status/data webhooks |
| `GET` | `/internal/v1/kyc-accounts/:account_id` | WebAuthn-protected founder/operations read of one account's operational KYC eligibility record |
| `POST` | `/v1/origination-cases` | Create an authenticated, eligibility-gated draft owner intake |
| `GET` | `/v1/origination-cases?limit=20&after=...` | List the authenticated owner's cases |
| `GET` | `/v1/origination-cases/:case_id` | Read one owner-scoped case; out-of-scope IDs return `404` |
| `POST` | `/v1/origination-cases/:case_id/submit` | Submit a draft as immutable revision 1 with required evidence |
| `GET` | `/v1/origination-cases/:case_id/information-requests` | List the owner's published request history |
| `POST` | `/v1/origination-cases/:case_id/information-requests/:request_id/respond` | Answer the current request with immutable revision N+1 |
| `GET` | `/v1/origination-cases/:case_id/messages` | Read the owner's own case's `applicant`-lane discussion thread |
| `POST` | `/v1/origination-cases/:case_id/messages` | Post to the `applicant` lane on the owner's own case |
| `GET` | `/internal/v1/origination-cases?stage=submitted&limit=20&after=...` | WebAuthn-protected founder operations case queue |
| `GET` | `/internal/v1/origination-cases/:case_id` | Founder review detail, current revision, evidence, and request history |
| `POST` | `/internal/v1/origination-cases/:case_id/information-requests` | Publish an owner request and start the configured response window |
| `POST` | `/internal/v1/origination-cases/:case_id/decisions` | Approve with IPO terms or reject a submitted case |
| `POST` | `/internal/v1/origination-cases/:case_id/close` | Withdraw (any pre-terminal stage) or late-stage reject (`pre_offering_open` only) a case |
| `GET` | `/internal/v1/origination-cases/:case_id/messages?lane=internal_case\|applicant` | Read either discussion lane on any case |
| `POST` | `/internal/v1/origination-cases/:case_id/messages` | Post to either lane on any case, as the founder |

All errors follow the documented envelope: `type`, `code`, `title`, `status`, `detail`, `trace_id`, and optional `field_errors`.

## Database notes

The Prisma schema lives at `prisma/schema.prisma`; reviewed SQL migrations are under `prisma/migrations`. Check constraints and append-only revision enforcement that Prisma cannot express are maintained directly in migration SQL. Better Auth owns its four `public.auth_*` tables through its PostgreSQL adapter; `oidc-provider` likewise owns `public.oidc_model_instances` through its own adapter (`src/modules/auth/infrastructure/postgres-oidc-adapter.ts`) — product code deliberately does not model or query either through Prisma. The runtime uses the generated client in `src/generated/prisma`, which is deliberately excluded from Git and regenerated during setup/build.
