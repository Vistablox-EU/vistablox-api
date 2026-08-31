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
- KYC/proof-of-address-gated owner intake at `POST /v1/origination-cases`
- owner-scoped origination case list/detail reads with opaque cursor pagination
- append-only initial submission revisions with mandatory evidence and audit logging
- founder-only origination review surface secured by active `admin_operations` assignment
- structured information requests, owner resubmission as immutable revision N+1, and atomic request resolution
- founder approval/rejection with review record, IPO terms, lifecycle transition, and audit logging
- Prisma 7 client using the PostgreSQL driver adapter
- all eight documented PostgreSQL schemas and their current tables, relations, indexes, and explicit check constraints
- Vitest API and domain tests
- dependency boundary checks for the documented `router -> schema -> application service -> domain policy -> repository` layering

Native-client OIDC, customer TOTP, customer session/device management, auth rate limiting, provider callbacks, async reminder/expiry workers, and general API idempotency middleware remain subsequent implementation slices. Better Auth login success/failure, session creation/revocation, password change/reset, WebAuthn outcomes, staff invitation actions, recovery, and offboarding now feed the unified audit trail. A WebAuthn-verified administrator provisions staff and partner identities through single-use email invitations; after acceptance, the invited user signs in and enrolls a first WebAuthn credential, while adding any later credential requires an already WebAuthn-verified session. That same protected admin surface can initiate a staff reset or immediately offboard an identity; the code intentionally does not enable Better Auth's impersonation-capable admin plugin. Information-request due dates currently exclude Saturdays and Sundays; a jurisdiction-aware holiday calendar remains future work.

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

## Commands

```bash
npm run check          # type checking, architecture rules, tests
npm run build          # production TypeScript build
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
