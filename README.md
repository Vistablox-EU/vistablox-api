# VistaBlox API

API-only backend for VistaBlox. This repository is being implemented from the architecture record in `../Docs/Backend`; when code and those documents disagree, the current design record and `03-Database/CORE_TABLES.md` take precedence.

## Implemented foundation

- Express 5 and TypeScript API runtime
- Zod validation for requests, responses, environment variables, and errors
- stable error envelope with a trace ID
- structured, redacted JSON logging
- liveness and database-readiness endpoints
- first layered product slice: public offering teasers at `GET /v1/offerings`
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
- Redis/Valkey-backed, 24-hour protected cache for Didit-verified display names
- KYC/proof-of-address-gated owner intake at `POST /v1/origination-cases`
- owner-scoped origination case list/detail reads with opaque cursor pagination
- append-only initial submission revisions with mandatory evidence and audit logging
- founder-only origination review surface secured by active `admin_operations` assignment
- structured information requests, owner resubmission as immutable revision N+1, and atomic request resolution
- founder approval/rejection with review record, IPO terms, lifecycle transition, and audit logging
- Redis/Valkey-backed general-purpose rate limiting across `/v1`, `/internal/v1`, and Better Auth's endpoints: a generous baseline tier keyed by `account_id` (or caller IP when unauthenticated), and a stricter tightened tier on fresh-auth attempts (Better Auth sign-in/sign-up/password-reset, staff WebAuthn ceremonies, staff invitation acceptance); fails open with a logged warning if the rate-limit cache is unavailable
- a dedicated `pg-boss` worker process (`npm run worker:dev` / `npm run worker:start`) running the `case_timers`/`maintenance` scheduled jobs: applicant response-window reminders and automatic expiry once `due_at` passes, plus KYC renewal reminders and the automatic `requires_renewal` transition once `renewal_due_at` passes
- Prisma 7 client using the PostgreSQL driver adapter
- all eight documented PostgreSQL schemas and their current tables, relations, indexes, and explicit check constraints
- Vitest API and domain tests
- dependency boundary checks for the documented `router -> schema -> application service -> domain policy -> repository` layering

Native-client OIDC, customer TOTP, customer session/device management, and general API idempotency middleware remain subsequent implementation slices. Rate-limit tier thresholds are a fixed starting point (`src/shared/http/rate-limit.ts`) pending real production traffic to tune against, per `RATE_LIMITING.md`. Better Auth login success/failure, session creation/revocation, password change/reset, WebAuthn outcomes, staff invitation actions, recovery, and offboarding now feed the unified audit trail. A WebAuthn-verified administrator provisions staff and partner identities through single-use email invitations; after acceptance, the invited user signs in and enrolls a first WebAuthn credential, while adding any later credential requires an already WebAuthn-verified session. That same protected admin surface can initiate a staff reset or immediately offboard an identity; the code intentionally does not enable Better Auth's impersonation-capable admin plugin. Operations-review decision display, cross-validation of declared identity data, and asynchronous webhook processing remain follow-on KYC work. Information-request due dates currently exclude Saturdays and Sundays; a jurisdiction-aware holiday calendar remains future work.

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

The scheduled-job worker is a separate process from the API and must be started alongside it for reminders/expiry to run: `npm run worker:dev` locally, `npm run worker:start` against a build. It shares `DATABASE_URL`/SMTP configuration with the API and needs no additional environment variables.

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
```

## HTTP surface currently available

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health/live` | Process liveness; does not query dependencies |
| `GET` | `/health/ready` | Readiness; verifies PostgreSQL connectivity |
| `GET/POST` | `/api/auth/*` | Better Auth browser authentication endpoints |
| `POST` | `/internal/v1/auth/webauthn/registration/options` | Begin staff credential enrollment |
| `POST` | `/internal/v1/auth/webauthn/registration/verify` | Verify and store a staff credential; marks the session MFA-complete |
| `POST` | `/internal/v1/auth/webauthn/authentication/options` | Begin mandatory staff session MFA |
| `POST` | `/internal/v1/auth/webauthn/authentication/verify` | Verify a staff assertion and mark the session MFA-complete |
| `POST` | `/internal/v1/auth/staff-invitations` | Issue a role-scoped staff/partner invitation; requires admin role and WebAuthn |
| `POST` | `/v1/auth/staff-invitations/accept` | Accept an emailed invitation and set the initial password |
| `POST` | `/internal/v1/auth/staff-accounts/:account_id/recovery` | Revoke staff sessions/WebAuthn credentials and email a password reset; requires another admin and WebAuthn |
| `POST` | `/internal/v1/auth/staff-accounts/:account_id/offboard` | Disable staff login and revoke sessions, roles, and credentials; requires another admin and WebAuthn |
| `GET` | `/v1/offerings?limit=20&after=...` | Cursor-paginated public offering teasers |
| `GET` | `/v1/investor-profile` | Read the authenticated customer's cross-domain investor profile aggregate |
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

The Prisma schema lives at `prisma/schema.prisma`; reviewed SQL migrations are under `prisma/migrations`. Check constraints and append-only revision enforcement that Prisma cannot express are maintained directly in migration SQL. Better Auth owns its four `public.auth_*` tables through its PostgreSQL adapter; product code deliberately does not model or query those tables through Prisma. The runtime uses the generated client in `src/generated/prisma`, which is deliberately excluded from Git and regenerated during setup/build.
