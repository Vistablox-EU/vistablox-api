# Staff and partner authentication routes

Valid for main at 48aa967 (2026-11-18).

This reference lists every route under the auth module that staff and partners use, or that staff operate on behalf of customers: the invitation routes, the WebAuthn step-up routes, the roster and role-administration routes, staff recovery and offboarding, the customer account-recovery case routes and the customer account-closure review routes. It is read by the engineers who build the admin console and by whoever operates the platform. How staff and partners are modelled, how they sign in and what each guard enforces is in [../staff-access.md](../staff-access.md); the customer routes are in [auth-customer.md](auth-customer.md); the Better Auth routes under `/api/auth/*`, which carry the passkey sign-in, are in [better-auth.md](better-auth.md).

## Routes

| Method and path | Auth | Purpose |
| --- | --- | --- |
| [`POST /v1/auth/staff-invitations/accept`](#post-v1authstaff-invitationsaccept) | Invitation token, tight IP limiter | Accept an invitation: create the staff identity, assign the role, return the passkey registration context |
| [`POST /internal/v1/auth/staff-invitations`](#post-internalv1authstaff-invitations) | Admin chain | Issue an invitation and email the link |
| [`POST /internal/v1/auth/webauthn/registration/options`](#post-internalv1authwebauthnregistrationoptions) | Ceremony chain | Start registration of a step-up credential |
| [`POST /internal/v1/auth/webauthn/registration/verify`](#post-internalv1authwebauthnregistrationverify) | Ceremony chain | Finish registration; marks the session verified |
| [`POST /internal/v1/auth/webauthn/authentication/options`](#post-internalv1authwebauthnauthenticationoptions) | Ceremony chain | Start a step-up check with a registered credential |
| [`POST /internal/v1/auth/webauthn/authentication/verify`](#post-internalv1authwebauthnauthenticationverify) | Ceremony chain | Finish the check; marks the session verified |
| [`GET /internal/v1/auth/staff-accounts`](#get-internalv1authstaff-accounts) | Admin chain | List staff and partner accounts with their role history |
| [`POST /internal/v1/auth/staff-accounts/:account_id/roles`](#post-internalv1authstaff-accountsaccount_idroles) | Admin chain | Grant one more role to an existing staff account |
| [`POST /internal/v1/auth/staff-accounts/:account_id/roles/:assignment_id/revoke`](#post-internalv1authstaff-accountsaccount_idrolesassignment_idrevoke) | Admin chain | Revoke one role assignment |
| [`POST /internal/v1/auth/staff-accounts/:account_id/recovery`](#post-internalv1authstaff-accountsaccount_idrecovery) | Admin chain | Cut off a staff member's access and email a new passkey link |
| [`POST /internal/v1/auth/staff-accounts/:account_id/offboard`](#post-internalv1authstaff-accountsaccount_idoffboard) | Admin chain | Disable the identity, revoke every role, suspend the account |
| [`POST /internal/v1/account-recovery-cases`](#post-internalv1account-recovery-cases) | Admin chain | Open a full-lockout recovery case for a customer |
| [`GET /internal/v1/account-recovery-cases/:case_id`](#get-internalv1account-recovery-casescase_id) | Admin chain | Read a case, the live Didit status and the corroboration facts |
| [`POST /internal/v1/account-recovery-cases/:case_id/didit-sessions`](#post-internalv1account-recovery-casescase_iddidit-sessions) | Admin chain | Create the fresh Didit verification session |
| [`POST /internal/v1/account-recovery-cases/:case_id/primary-review`](#post-internalv1account-recovery-casescase_idprimary-review) | Admin chain | Record the primary review |
| [`POST /internal/v1/account-recovery-cases/:case_id/decision`](#post-internalv1account-recovery-casescase_iddecision) | Admin chain | Approve or reject, as a reviewer other than the primary one |
| [`POST /internal/v1/account-recovery-cases/:case_id/complete`](#post-internalv1account-recovery-casescase_idcomplete) | Admin chain | Complete an approved case |
| [`GET /internal/v1/account-closure-requests`](#get-internalv1account-closure-requests) | Admin chain | List pending customer closure requests |
| [`POST /internal/v1/account-closure-requests/:request_id/decision`](#post-internalv1account-closure-requestsrequest_iddecision) | Admin chain | Approve or reject a closure request |

"Admin chain", "ceremony chain" and "limiter" are defined in [Authentication building blocks](#authentication-building-blocks). These 19 routes are all that the staff and recovery routers under `src/modules/auth/api/staff` register (counted from the router files). The Better Auth passkey routes that staff use to sign in are not VistaBlox routes and are in [better-auth.md](better-auth.md). There is no staff route for device replacement: the replacement routes are customer self-service and refuse a staff target (see [auth-customer.md](auth-customer.md)). The other `/internal/v1` routes (intake, offerings, wallet, KYC, partner organisations, account search, partner case work) are in [intake-staff.md](intake-staff.md), [offering.md](offering.md), [wallet.md](wallet.md) and [platform.md](platform.md).

## How these routes behave

### Authentication building blocks

| Name | What runs, in this order | Source |
| --- | --- | --- |
| Admin chain | `requireAuthentication`, then `requireAdminOperations`, then `requireStaffWebAuthn`. Every route in the groups "staff roster", "recovery cases" and "closure review", and the invitation issue route, mount exactly these three, in this order | (`src/modules/auth/api/staff/staff-account-lifecycle.router.ts:35-39`, `src/modules/auth/api/staff/account-recovery.router.ts:40`, `src/modules/auth/api/staff/account-closure-operations.router.ts:16-49`, `src/modules/auth/api/staff/staff-invitation-issue.router.ts:17-37`) |
| Ceremony chain | The tight IP limiter on the mount, then `requireAuthentication`, then `requireStaffIdentity`. There is no `requireStaffWebAuthn` here: these routes are how a session obtains the proof | (`src/app.ts:1046-1053`, `src/modules/auth/api/staff/staff-webauthn.router.ts:19`) |
| `requireAuthentication` | Resolves the session (only `staff_passkey` and `device_biometric` levels are accepted), requires the DPoP proof only of a session that is bound to a key, loads the account and requires status `active`, sets `authContext`, applies the baseline limiter, records activity | (`src/modules/auth/api/shared/require-authentication.ts:39-129`) |
| `requireAdminOperations` | The session population is `staff_partner` and the account holds an active `admin_operations` assignment (one query per request) | (`src/modules/auth/api/staff/require-staff-role.ts:7-38`, `src/modules/account/repository/prisma-account.repository.ts:41-50`) |
| `requireStaffIdentity` | The population is `staff_partner` and the account holds at least one active assignment of any role | (`src/modules/auth/api/staff/require-staff-role.ts:74-90`, `src/modules/account/repository/prisma-account.repository.ts:52-58`) |
| `requireStaffWebAuthn` | The session is WebAuthn-verified: an active mirror row with `auth_method_at_login = 'staff_passkey'`, or a `staff_session_mfa` row for the session | (`src/modules/auth/api/staff/require-staff-role.ts:92-116`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:32-54`) |
| Tight limiter | 10 requests per 60 seconds per normalized client address, at the mount, before authentication. It exists only when a rate-limit store was ready at boot (`RATE_LIMIT_CACHE_URL`) | (`src/app.ts:471-474`, `src/shared/http/rate-limit.ts:23-27`, `src/shared/http/rate-limit.ts:35`) |
| Baseline limiter | 300 requests per 60 seconds per account, inside `requireAuthentication`, after the session and account checks. Same condition on the store | (`src/app.ts:467-470`, `src/shared/http/rate-limit.ts:17-21`, `src/modules/auth/api/shared/require-authentication.ts:114-124`) |

A staff session is created by a passkey ceremony, so it carries no DPoP key unless a valid proof was presented at creation; an unbound session is never required to present one (`src/modules/auth/api/shared/require-authentication.ts:62-66`). The tight limiter shares one key space across `/api/auth/*`, the device ceremonies, the invitation accept route and the WebAuthn step-up routes, because the key is `rate_limit_hint:tightened:<subject>` with no route in it (`src/shared/http/rate-limit.ts:35`). When the store fails a request is let through with a warning (`src/shared/http/rate-limit.ts:55-61`).

Requests are JSON: `express.json` with a 1 MB limit parses only bodies sent as `application/json`, and runs before every router named here (`src/app.ts:588`). A route that requires a body and receives none answers `422 validation.invalid_field`.

> Pending #237: `createApp` is split into per-module compose functions under `src/composition`; the mount order and conditions below do not change, but the `src/app.ts` line numbers cited in this file move.

### Common errors

Every route in this file can answer these. The entries below do not repeat them.

| Status | Code | Condition |
| --- | --- | --- |
| 400 | `request.invalid_json`, `request.aborted`, `request.size_mismatch` | The body is not parseable JSON, was cut short, or does not match `Content-Length` |
| 413 | `request.payload_too_large` | The body is larger than 1 MB |
| 415 | `request.unsupported_charset`, `request.unsupported_encoding` | The charset is not UTF-8 or the `Content-Encoding` is unsupported |
| 422 | `validation.invalid_field` | A path, query or body field fails its Zod schema; `field_errors` lists `field`, `code` and `message` per issue (`src/shared/http/error-handler.ts:51-64`) |
| 404 | `resource.not_found` | No route matches |
| 500 | `internal.unexpected` | Any exception that is not an `AppError` or a `ZodError` (`src/shared/http/error-handler.ts:46-73`) |

The envelope is `{ type, code, title, status, detail, trace_id, field_errors? }`. The body-parser codes and the envelope are described in [auth-customer.md](auth-customer.md#common-errors) and [README.md](README.md).

Routes that run `requireAuthentication` (every route except the invitation accept route) can also answer:

| Status | Code | Condition |
| --- | --- | --- |
| 401 | `authentication.required` | No accepted session: none sent, expired, a user with `disabledAt` or `recoveryRequiredAt` set, or a session level that is not accepted (`src/modules/auth/infrastructure/shared/better-auth-session.resolver.ts:61-71`) |
| 401 | `DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID`, `DPOP_REPLAY`, `DPOP_KEY_MISMATCH` | The session is bound to a key and the proof is absent, invalid, replayed, or made with another key. An unbound session created at or after `DPOP_PHASE1_CUTOVER_AT` (when that variable is set) that presents a valid proof also answers `DPOP_KEY_MISMATCH` (`src/modules/auth/api/shared/require-authentication.ts:62-66`, `src/modules/auth/api/shared/require-authentication.ts:203-239`) |
| 403 | `account.restricted` | The account status is not `active`, for example `suspended_restricted` after offboarding (`src/modules/auth/api/shared/require-authentication.ts:77-84`) |
| 500 | `account.mapping_missing` | The session's user has no local account (`src/modules/auth/api/shared/require-authentication.ts:68-76`) |
| 429 | `rate_limit.exceeded` | A limiter refused; the response carries `Retry-After: 60` (`src/shared/http/rate-limit.ts:40-51`) |
| 500 | `authentication.context_missing` | The guard ran without an auth context. Defensive; not reachable through the mounted routers (`src/modules/auth/api/staff/require-staff-role.ts:118-125`) |

The admin chain adds two answers, in this order:

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authorization.forbidden` | The session is not a `staff_partner` session or holds no active `admin_operations` assignment. Detail "The admin operations role is required for this action." (`src/modules/auth/api/staff/require-staff-role.ts:25-32`) |
| 403 | `authentication.staff_mfa_required` | The session is not WebAuthn-verified. Detail "Complete WebAuthn verification for this staff session." (`src/modules/auth/api/staff/require-staff-role.ts:105-109`) |

The ceremony chain answers `403 authorization.forbidden` with the detail "An active staff or partner role is required for this action." when the account holds no active assignment of any role (`src/modules/auth/api/staff/require-staff-role.ts:127-134`).

### Responses, caching and idempotency

A success body is parsed with its response schema before it is sent (`response.json(<schema>.parse(result))`). A body that fails the parse throws a `ZodError`, which the error handler answers as `422 validation.invalid_field` (`src/shared/http/error-handler.ts:51-64`).

> Pending #245: a success body that fails its response schema answers `500 internal.response_invalid` with a fixed detail and no `field_errors`, on every router in this file; on main it answers 422.

`GET /internal/v1/auth/staff-accounts`, `GET /internal/v1/account-recovery-cases/:case_id` and `GET /internal/v1/account-closure-requests` answer `Cache-Control: no-store`; no other route in this file sets a cache header. None of these routes mounts the `Idempotency-Key` middleware (it is mounted only on reservation creation, reconfirmation and finalization (`src/app.ts:490-501`); a repeated call repeats its side effects, and the entries say what that means for each route.

### Mounted when

Every route in this file is mounted when `createApp` receives `protectedApi`, which `server.ts` always passes (`src/server.ts:603`, `src/app.ts:596`), and, for the groups below, when the matching dependency is present. `server.ts` always supplies all of them, so on main every route here exists in every deployment.

| Group | Condition in `createApp` | Supplied at |
| --- | --- | --- |
| Invitations (accept and issue) | `protectedApi.staffInvitations !== undefined` (`src/app.ts:936-962`) | (`src/server.ts:745-750`) |
| Roster and role administration | `protectedApi.staffAccountLifecycle !== undefined` (`src/app.ts:963-985`) | (`src/server.ts:733-739`) |
| Recovery cases | `protectedApi.accountRecovery !== undefined` (`src/app.ts:986-1023`) | (`src/server.ts:398-409`) |
| Closure review | `protectedApi.accountClosure !== undefined` (`src/app.ts:1024-1044`) | (`src/server.ts:741-744`) |
| WebAuthn step-up | unconditional inside the `protectedApi` block (`src/app.ts:1046-1053`) | no dependency of its own beyond the repository and ceremony (`src/server.ts:626-630`) |

## Staff invitations

A staff or partner identity exists only because an `admin_operations` staff member invited it, or, for the first admin, because the bootstrap command issued the invitation ([../cli.md](../cli.md)). The invitation row holds the role and, for a partner, the legal practice or appraisal firm; the identity is created when the invitation is accepted, not when it is issued. The lifecycle (72-hour lifetime, single use, supersession, the 10-minute claim) is in [../staff-access.md](../staff-access.md#2-invitations).

### POST /internal/v1/auth/staff-invitations

**Auth.** Admin chain. Baseline limiter per account. No idempotency key.

**Mounted when.** `protectedApi.staffInvitations` is set; always on main (see [Mounted when](#mounted-when)).

**Request.** JSON body, discriminated by `role` (`src/modules/auth/api/staff/staff-invitation-issue.schemas.ts:8-27`, `src/modules/auth/api/staff/staff-invitation-issue.schemas.ts:3-6`).

| Field | Type | Rule |
| --- | --- | --- |
| `email` | string | A valid email address; lower-cased after validation. The address must not belong to any Better Auth user |
| `display_name` | string | Trimmed, 1 to 200 characters |
| `role` | enum | `admin_operations`, `legal_partner` or `appraisal_partner`; any other value is 422 |
| `legal_practice_id` | string or null | `legal_partner`: required, trimmed, at least 1 character. The other two roles: must be `null` or absent (default `null`) |
| `appraisal_firm_id` | string or null | `appraisal_partner`: required, trimmed, at least 1 character. The other two roles: must be `null` or absent (default `null`) |

A partner role without its organisation id, or any role with the other role's id, fails the schema. The database repeats the rule in the check `staff_invitations_role_scope_check` (`prisma/migrations/20260831180000_staff_invitations/migration.sql:25-28`).

**Success.** `201 { data: { invitation_id, expires_at } }`. `invitation_id` is `invite_` plus a ULID; `expires_at` is the creation time plus 72 hours (`src/modules/auth/api/staff/staff-invitation-issue.schemas.ts:29-34`, `src/modules/auth/application/staff/staff-invitation.service.ts:9`). The response is parsed through `issueStaffInvitationResponseSchema`. The token is never in the response; it exists only in the email.

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.staff_invitation_email_unavailable` | A Better Auth user with this email exists, whatever its population (`src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:9-12`, `src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:92-99`) |
| 503 | `authentication.staff_invitation_delivery_failed` | The email could not be sent. The invitation is revoked in the same call (audit `authentication.staff_invitation_revoked`, reason `delivery_failed`), so no link works; the caller repeats the request (`src/modules/auth/application/staff/staff-invitation.service.ts:59-73`, `src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:68-92`) |
| 500 | `internal.unexpected` | `legal_practice_id` or `appraisal_firm_id` names no row: nothing in the service looks the organisation up, and the foreign keys reject the insert. Inferred from the code and the schema; not executed (see [Known limitations](#known-limitations)) (`src/modules/auth/application/staff/staff-invitation.service.ts:39-50`, `prisma/migrations/20260831180000_staff_invitations/migration.sql:57-62`) |

**Notes.** One transaction in `createInvitation` revokes every pending invitation for the same email (it sets `revoked_at`; no audit row is written for those), inserts the new row and writes the audit row `authentication.staff_invitation_issued` whose `changes` are `trace_id`, `role`, `legal_practice_id`, `appraisal_firm_id` and `expires_at` (the email is not in it) (`src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:13-66`, `src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:26-33`, `src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:52`). A partial unique index allows one pending invitation per email (`prisma/migrations/20260831180000_staff_invitations/migration.sql:36-38`). The token is 32 random bytes encoded base64url; only its SHA-256 hex is stored (`src/modules/auth/application/staff/staff-invitation.service.ts:134-137`, `src/modules/auth/application/staff/staff-invitation.service.ts:139-141`). The email is sent after the commit, with the link `<STAFF_INVITATION_ACCEPT_URL>?token=<token>`; the subject is "Your VistaBlox staff invitation" (`src/modules/auth/application/staff/staff-invitation.service.ts:143-147`, `src/infrastructure/email/smtp-email-sender.ts:96-105`). The mail transport sets no explicit timeouts (`src/infrastructure/email/smtp-email-sender.ts:88-93`); the library's defaults apply: 2 minutes to connect, 30 seconds for the greeting and 10 minutes of socket inactivity in the pinned version 9.1.0 (`node_modules/nodemailer/lib/smtp-connection/index.js:14-16`, version per `package-lock.json:5942-5943`). Nothing creates the legal practice or appraisal firm: it must exist first (`POST /internal/v1/legal-practices`, `POST /internal/v1/appraisal-firms`, see [intake-staff.md](intake-staff.md)). Each call sends one email; the only throttle is the baseline limiter.

**Source.** Router (`src/modules/auth/api/staff/staff-invitation-issue.router.ts:17-37`); service (`src/modules/auth/application/staff/staff-invitation.service.ts:12-82`); repository (`src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:13-66`); identity check (`src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:9-12`).

### POST /v1/auth/staff-invitations/accept

**Auth.** None: the single-use token is the credential. The tight IP limiter runs on the mount before the router; there is no baseline limiter because `requireAuthentication` does not run (`src/app.ts:949-950`, `src/app.ts:471-474`).

**Mounted when.** `protectedApi.staffInvitations` is set; always on main (see [Mounted when](#mounted-when)).

**Request.** JSON body `{ "token": string }`, 32 to 512 characters, not trimmed (`src/modules/auth/api/staff/staff-invitation-accept.schemas.ts:3-5`). A token that VistaBlox issued is 43 characters. The accept page of the admin console reads the `token` query parameter of the emailed link and posts it here; the console is not in this repository (Not verified).

**Success.** `200 { data: { accepted: true, account_id, webauthn_enrollment_required: true, passkey_registration_context } }`, parsed through `acceptStaffInvitationResponseSchema` (`src/modules/auth/api/staff/staff-invitation-accept.schemas.ts:7-14`). `account_id` is the new `account.accounts` id. `passkey_registration_context` is 43 characters: 32 random bytes, base64url (`src/modules/auth/infrastructure/shared/passkey-bootstrap.ts:7-32`). It is the only way to register the first passkey, it is returned once, it is valid for 15 minutes (`src/modules/auth/infrastructure/shared/passkey-bootstrap.ts:5`), and the passkey ceremony consumes it ([../staff-access.md](../staff-access.md#3-signing-in-and-the-webauthn-proof)).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.staff_invitation_unavailable` | One answer for: unknown token, expired, revoked, already accepted, claimed by another call less than 10 minutes ago, or changed while this call ran (`src/modules/auth/application/staff/staff-invitation.service.ts:149-156`, `src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:106-107`) |
| 409 | `authentication.staff_invitation_email_unavailable` | A Better Auth user with the invitation's email exists and is not a `staff_partner` user, for example a customer who signed up after the invitation was issued (`src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:14-59`) |
| 422 | `authentication.staff_identity_invalid` | Better Auth refused to create the user with a 4xx status (`src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:72-90`) |
| 503 | `authentication.staff_identity_creation_failed` | Better Auth failed to create the user in any other way (`src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:72-90`) |
| 429 | `rate_limit.exceeded` | More than 10 requests in 60 seconds from one address, shared with the other tight-limiter mounts; only with a rate-limit store |
| 500 | `internal.unexpected` | The created Better Auth user has no VistaBlox account row (`src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:155`), or the database failed. The claim is released (`src/modules/auth/application/staff/staff-invitation.service.ts:124-128`) |

**Notes.** In order: (1) one conditional update claims the invitation by token hash (not accepted, not revoked, not expired, and either unclaimed or claimed more than 10 minutes ago) (`src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:94-117`); (2) the identity provider finds the Better Auth user by email or creates it with `emailVerified: true` and population `staff_partner`, which the user-created hook turns into an `account.accounts` row (status `active`, `protected_contact_email` the invitation's email) (`src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:35-40`, `src/modules/account/application/account-provisioner.ts:8-13`); (3) a passkey bootstrap value is stored as an `auth_verification` row, 15 minutes, `replaceCredentials: false` (`src/modules/auth/infrastructure/shared/passkey-bootstrap.ts:7-32`); (4) one transaction re-checks the claim and expiry, inserts the role assignment (`role_` plus a ULID, with `legal_practice_id` and `appraisal_firm_id` from the invitation), marks the invitation accepted and clears the claim, and writes the audit row `authentication.staff_invitation_accepted` with the new account as actor (`src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:131-199`, `src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:157-166`, `src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:188`). A failure after step 1 releases the claim, so the same token can be tried again (`src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:119-129`); a Better Auth user created in step 2 stays. The provisioning instance has no audit sink, so no `authentication.identity_created` row is written for the invited identity (`src/server.ts:370-380`, `src/modules/auth/infrastructure/shared/better-auth.factory.ts:432-452`). The call needs no session and returns no cookie: the staff member registers the first passkey with the context and then signs in with it.

**Source.** Router (`src/modules/auth/api/staff/staff-invitation-accept.router.ts:13-20`); service (`src/modules/auth/application/staff/staff-invitation.service.ts:84-131`); repository (`src/modules/auth/repository/staff/prisma-staff-invitation.repository.ts:131-199`); identity provider (`src/modules/auth/infrastructure/staff/better-auth-staff-identity.provider.ts:14-59`).

## WebAuthn step-up

These four routes manage the credentials in `auth.staff_webauthn_credentials` and mark a session as verified. They are a separate credential set from the passkeys with which a staff member signs in (Better Auth's `passkey` table). A session created by a passkey sign-in already counts as verified, so on main these routes are needed only to register or use a step-up credential in addition; the difference is in [../staff-access.md](../staff-access.md#3-signing-in-and-the-webauthn-proof). All four sit behind the ceremony chain, share the tight IP limiter, and use the challenge table `auth.staff_webauthn_challenges`: a challenge is bound to the account, the Better Auth session and the purpose, is single use, and lives 5 minutes (`src/modules/auth/application/staff/staff-webauthn.service.ts:10`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:91-109`).

The ceremony settings come from `WEBAUTHN_RP_NAME` (default `VistaBlox`, `src/config/environment.ts:29`), `WEBAUTHN_RP_ID` (default: the host of `BETTER_AUTH_URL`) and `WEBAUTHN_ORIGIN` (default: the origin of `BETTER_AUTH_URL`); the expected origins are the web origins only, so a native Android origin is not accepted here (`src/config/environment.ts:699-715`, `src/server.ts:626-630`). Both verifications require user verification, and registration also sets user presence explicitly (`src/modules/auth/infrastructure/staff/simple-webauthn.ceremony.ts:46-66`, `src/modules/auth/infrastructure/staff/simple-webauthn.ceremony.ts:82-104`).

### POST /internal/v1/auth/webauthn/registration/options

**Auth.** Ceremony chain. Tight IP limiter and baseline limiter per account.

**Mounted when.** Unconditional inside the `protectedApi` block (`src/app.ts:1046-1053`).

**Request.** JSON body, required (an absent body is `422`; send `{}`): `credential_label` is a string trimmed to 1 to 100 characters or `null`, default `null` (`src/modules/auth/api/staff/staff-webauthn.schemas.ts:19-21`).

**Success.** `200 { data: { challenge_id, public_key } }` (`src/modules/auth/api/staff/staff-webauthn.schemas.ts:55-60`). `challenge_id` is `wch_` plus a ULID. `public_key` is the WebAuthn creation options: relying party name `WEBAUTHN_RP_NAME` and id, the account id as user handle, name and display name, attestation `none`, timeout 300 000 ms, the account's existing credentials in `excludeCredentials`, resident key `preferred`, user verification `required` (`src/modules/auth/infrastructure/staff/simple-webauthn.ceremony.ts:26-44`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authentication.staff_mfa_required` | The account already has at least one step-up credential and this session is not verified. Detail "Authenticate with a registered WebAuthn credential before adding another." (`src/modules/auth/application/staff/staff-webauthn.service.ts:202-217`) |

**Notes.** The first credential can be registered by any staff session. A second one needs a verified session. Earlier unused registration challenges of the same account and session are marked used, so only the latest challenge can be completed (`src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:56-89`). The label is stored on the challenge and copied to the credential at completion.

**Source.** Router (`src/modules/auth/api/staff/staff-webauthn.router.ts:21-30`); service (`src/modules/auth/application/staff/staff-webauthn.service.ts:19-42`).

### POST /internal/v1/auth/webauthn/registration/verify

**Auth.** Ceremony chain. Tight IP limiter and baseline limiter per account.

**Mounted when.** Unconditional inside the `protectedApi` block.

**Request.** JSON body (`src/modules/auth/api/staff/staff-webauthn.schemas.ts:23-38`, `src/modules/auth/api/staff/staff-webauthn.schemas.ts:7-17`):

| Field | Type | Rule |
| --- | --- | --- |
| `challenge_id` | string | Non-empty; the value from the options call |
| `response.id`, `response.rawId` | string | Non-empty base64url |
| `response.type` | string | The literal `public-key` |
| `response.authenticatorAttachment` | string, optional | `platform` or `cross-platform` |
| `response.clientExtensionResults` | object | Any record |
| `response.response.clientDataJSON`, `.attestationObject` | string | Non-empty base64url |
| `response.response.authenticatorData`, `.publicKey` | string, optional | Base64url |
| `response.response.transports` | array, optional | Values from `ble`, `cable`, `hybrid`, `internal`, `nfc`, `smart-card`, `usb` |
| `response.response.publicKeyAlgorithm` | integer, optional | |

**Success.** `200 { data: { verified: true, credential_id, staff_mfa_verified: true } }` (`src/modules/auth/api/staff/staff-webauthn.schemas.ts:62-68`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.webauthn_challenge_invalid` | The challenge is unknown, used, expired, of another account, session or purpose, or was consumed by a concurrent call (`src/modules/auth/application/staff/staff-webauthn.service.ts:228-235`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:152-227`) |
| 403 | `authentication.staff_mfa_required` | The account already has a credential and this session is not verified (checked after the challenge lookup) |
| 401 | `authentication.webauthn_verification_failed` | The attestation failed verification or the library threw. The challenge is consumed and the audit row `authentication.staff_webauthn_challenge_failed` (reason `verification_failed`) is written (`src/modules/auth/application/staff/staff-webauthn.service.ts:237-244`, `src/modules/auth/application/staff/staff-webauthn.service.ts:220-226`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:111-150`) |

**Notes.** One transaction consumes the challenge, inserts the credential (id, public key, counter, device type, backed-up flag, transports, label), upserts the `staff_session_mfa` row for this session (which marks the session verified) and writes the audit row `authentication.staff_webauthn_credential_registered` (`src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:152-227`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:183-194`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:195-208`). The response origin must be one of the configured web origins.

**Source.** Router (`src/modules/auth/api/staff/staff-webauthn.router.ts:32-43`); service (`src/modules/auth/application/staff/staff-webauthn.service.ts:44-105`); ceremony (`src/modules/auth/infrastructure/staff/simple-webauthn.ceremony.ts:46-66`).

### POST /internal/v1/auth/webauthn/authentication/options

**Auth.** Ceremony chain. Tight IP limiter and baseline limiter per account.

**Mounted when.** Unconditional inside the `protectedApi` block.

**Request.** No body is read.

**Success.** `200 { data: { challenge_id, public_key } }`; `public_key` is the WebAuthn request options with the account's credentials in `allowCredentials`, user verification `required` and a 300 000 ms timeout (`src/modules/auth/infrastructure/staff/simple-webauthn.ceremony.ts:68-80`, `src/modules/auth/api/staff/staff-webauthn.schemas.ts:55-60`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.staff_webauthn_enrollment_required` | The account has no step-up credential (`src/modules/auth/application/staff/staff-webauthn.service.ts:246-253`) |

**Notes.** Earlier unused authentication challenges of the same account and session are marked used.

**Source.** Router (`src/modules/auth/api/staff/staff-webauthn.router.ts:45-52`); service (`src/modules/auth/application/staff/staff-webauthn.service.ts:107-126`).

### POST /internal/v1/auth/webauthn/authentication/verify

**Auth.** Ceremony chain. Tight IP limiter and baseline limiter per account.

**Mounted when.** Unconditional inside the `protectedApi` block.

**Request.** JSON body `{ challenge_id, response }`; `response` is the authentication response with `id`, `rawId`, `type`, optional `authenticatorAttachment`, `clientExtensionResults` and `response.{clientDataJSON, authenticatorData, signature, userHandle?}`, all base64url (`src/modules/auth/api/staff/staff-webauthn.schemas.ts:40-53`).

**Success.** `200 { data: { verified: true, credential_id, staff_mfa_verified: true } }`.

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.webauthn_challenge_invalid` | As for registration verify |
| 401 | `authentication.webauthn_verification_failed` | The credential id is not one of this account's credentials, or verification failed. The challenge is consumed and the audit row `authentication.staff_webauthn_challenge_failed` is written with reason `credential_not_found` or `verification_failed` (`src/modules/auth/application/staff/staff-webauthn.service.ts:128-200`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:111-150`) |
| 500 | `internal.unexpected` | The stored counter changed between the read and the update, which happens when two verifications of one credential run at once (`src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:259`, `src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:269`) |

**Notes.** One transaction consumes the challenge, advances the credential's counter only if it still equals the value that was read, upserts the `staff_session_mfa` row for the session and writes the audit row `authentication.staff_webauthn_challenge_succeeded` (`src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:229-300`). This call does not change the session's fresh-authentication timestamp ([../staff-access.md](../staff-access.md#session-handling-compared-with-customers)).

**Source.** Router (`src/modules/auth/api/staff/staff-webauthn.router.ts:54-65`); service (`src/modules/auth/application/staff/staff-webauthn.service.ts:128-200`); repository (`src/modules/auth/repository/staff/prisma-staff-webauthn.repository.ts:229-300`).

## Staff roster and role administration

These five routes run behind the admin chain and share three rules: the target is named in the path, an administrator cannot act on their own account (`403 authentication.staff_account_self_action_forbidden`, detail "Staff recovery, offboarding, and role changes must be performed by another administrator."), and every state change writes an audit row (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:207-216`, `src/modules/auth/api/staff/staff-account-lifecycle.router.ts:35-39`). The other administrator is not asked for approval; one administrator can act alone on any other account, including another administrator's.

### GET /internal/v1/auth/staff-accounts

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.staffAccountLifecycle` is set; always on main.

**Request.** No parameters, no body.

**Success.** `200`, header `Cache-Control: no-store`, parsed through `listStaffAccountsResponseSchema` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:42-51`, `src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:31-38`).

| Field | Type | Value |
| --- | --- | --- |
| `data[].account_id` | string | The VistaBlox account id |
| `data[].email` | string or null | `account.accounts.protected_contact_email`; null when no verified email is on file |
| `data[].status` | enum | `active`, `recovery_review` or `suspended_restricted` |
| `data[].roles[].assignment_id` | string | `role_` plus a ULID; the id to pass to the revoke route |
| `data[].roles[].role` | enum | `admin_operations`, `legal_partner` or `appraisal_partner` |
| `data[].roles[].legal_practice_id` | string or null | Set for `legal_partner` |
| `data[].roles[].appraisal_firm_id` | string or null | Set for `appraisal_partner` |
| `data[].roles[].granted_at` | ISO-8601 | |
| `data[].roles[].revoked_at` | ISO-8601 or null | Null while the assignment is active |

**Errors.** None beyond the common ones.

**Notes.** The list holds every account that has ever had an assignment, revoked ones and offboarded ones included, ordered by account creation (oldest first); each account's roles are ordered by `granted_at`, newest first. The list is not paginated: the roster is bounded by headcount (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:149-177`). A reader decides who is currently active from `revoked_at` and `status`.

**Source.** Router (`src/modules/auth/api/staff/staff-account-lifecycle.router.ts:41-45`); service (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:115-129`); repository (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:149-177`).

### POST /internal/v1/auth/staff-accounts/:account_id/roles

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.staffAccountLifecycle` is set; always on main.

**Request.** Path `account_id`, trimmed, at least 1 character (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:3-5`). JSON body, discriminated by `role`, with the same rules as the invitation body without `email` and `display_name` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:53-69`): `admin_operations` takes no organisation id; `legal_partner` requires `legal_practice_id`; `appraisal_partner` requires `appraisal_firm_id`; the other id must be `null` or absent.

**Success.** `201 { data: { assignment_id, role, legal_practice_id, appraisal_firm_id, granted_at, revoked_at } }` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:71-73`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authentication.staff_account_self_action_forbidden` | `account_id` is the caller's own account |
| 409 | `authentication.staff_account_target_unavailable` | The account does not exist, is not `active`, or holds no active assignment of any role (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:147`, `src/modules/auth/application/staff/staff-account-lifecycle.service.ts:218-225`) |
| 409 | `authentication.staff_role_already_granted` | The account holds an active assignment of this role, for any organisation (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:150-154`, `src/modules/auth/application/staff/staff-account-lifecycle.service.ts:227-234`) |
| 500 | `internal.unexpected` | The organisation id names no row (foreign key); inferred, not executed (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:187-234`, `prisma/migrations/20260831150000_initial_schema/migration.sql:750-753`) |

**Notes.** The route only adds a role to an account that is already staff; a new person is invited instead. It creates the assignment and the audit row `authentication.staff_role_granted` (`trace_id`, `assignment_id`, `role`, both organisation ids) in one transaction (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:187-234`). The "already granted" check and the insert are separate statements and no unique index covers the pair, so two simultaneous grants of the same role can both succeed (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:150-154`, `src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:179-185`). Sessions are not touched: the role checks read the assignment table on every request, so the new role works on the target's next request. Roles are additive; nothing forbids one account from holding `admin_operations` and a partner role.

**Source.** Router (`src/modules/auth/api/staff/staff-account-lifecycle.router.ts:47-61`); service (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:131-168`); repository (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:187-234`).

### POST /internal/v1/auth/staff-accounts/:account_id/roles/:assignment_id/revoke

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.staffAccountLifecycle` is set; always on main.

**Request.** Path `account_id` and `assignment_id`, each trimmed, at least 1 character (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:7-10`). No body is read.

**Success.** `200 { data: { revoked: true } }` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:75-77`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authentication.staff_account_self_action_forbidden` | `account_id` is the caller's own account |
| 409 | `authentication.staff_account_target_unavailable` | The assignment does not exist, belongs to another account, or is already revoked (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:236-278`) |

**Notes.** The assignment gets `revoked_at` and the audit row `authentication.staff_role_revoked` is written in one transaction. The route does not check whether the account keeps another role, does not touch the account status, the Better Auth user, the sessions or the credentials. The effect on routes is immediate, because every guard reads the table per request; the account then answers `403 authorization.forbidden` on role-gated routes. An account whose last role is revoked cannot be given a role again through the API: the grant route needs an active role on the target, and the invitation route refuses an email that already has a Better Auth user ([../staff-access.md](../staff-access.md#known-limitations)).

**Source.** Router (`src/modules/auth/api/staff/staff-account-lifecycle.router.ts:63-78`); service (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:170-194`); repository (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:236-278`).

### POST /internal/v1/auth/staff-accounts/:account_id/recovery

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.staffAccountLifecycle` is set; always on main.

**Request.** Path `account_id` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:3-5`). The body must be absent or an empty object; a body with any key fails the strict schema with 422 (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:12`).

**Success.** `202 { data: { recovery_started: true, webauthn_reenrollment_required: true } }` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:18-23`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authentication.staff_account_self_action_forbidden` | `account_id` is the caller's own account |
| 409 | `authentication.staff_account_target_unavailable` | The account does not exist, is not `active`, or holds no active role (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:12-78`) |
| 409 | `authentication.staff_account_target_invalid` | The Better Auth user is not a `staff_partner` user (`src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:75-96`) |
| 409 | `authentication.staff_account_disabled` | The Better Auth user is disabled while the account is still `active`, for example after an offboarding that stopped between its two steps; a fully offboarded account is `suspended_restricted` and answers `staff_account_target_unavailable` first (`src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:98-109`, `src/modules/auth/application/staff/staff-account-lifecycle.service.ts:12-78`) |
| 503 | `authentication.staff_recovery_delivery_failed` | Access was revoked but the recovery email could not be sent. Detail: "Existing access was revoked, but the recovery email could not be delivered. The operation can be retried safely." (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:62-67`) |

> Pending #244: every 5xx response carries a fixed detail sentence, so the 503 above no longer shows this text.

**Notes.** In order: (1) the Better Auth user gets `recoveryRequiredAt` and every session of the user is deleted, which writes the session audit rows and marks the mirror rows revoked (`src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:16-27`); if the transaction in (2) then finds the account no longer eligible (not `active`, or without an active role), the call answers `409 authentication.staff_account_target_unavailable` after step (1) has already run (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:40-46`, `src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:47-56`; read from the code, not executed); (2) one transaction deletes the account's `staff_session_mfa` rows, `staff_webauthn_challenges` and `staff_webauthn_credentials` and writes `authentication.staff_account_recovery_started` with the number of credentials removed (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:41-84`, `src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:58-64`); (3) a passkey bootstrap with `replaceCredentials: true` is stored (15 minutes) and the email "Create a new VistaBlox passkey" is sent to the user's email with the link `<STAFF_RECOVERY_REDIRECT_URL>?context=<context>`, default the path `/staff/recover-account` on the origin of `BETTER_AUTH_URL` (`src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:29-49`, `src/infrastructure/email/smtp-email-sender.ts:198-207`, `src/modules/auth/infrastructure/shared/passkey-bootstrap.ts:34-38`). A failed send writes `authentication.staff_account_recovery_delivery_failed` and answers 503; repeating the call issues a new link. Until the staff member registers a new passkey with the context, the Better Auth guard refuses every sign-in of the user with `STAFF_ACCOUNT_RECOVERY_REQUIRED`, except the registration ceremony itself (`src/modules/auth/infrastructure/staff/better-auth-staff-account-guard.plugin.ts:57-62`, `src/modules/auth/infrastructure/staff/better-auth-staff-account-guard.plugin.ts:98-100`). Registering with the context deletes the user's existing Better Auth passkeys and clears `recoveryRequiredAt` (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:388-393`, `src/modules/auth/infrastructure/shared/better-auth.factory.ts:400`). If the 15 minutes pass, the administrator repeats the call. The route sends one email per call with the baseline limiter only.

**Source.** Router (`src/modules/auth/api/staff/staff-account-lifecycle.router.ts:80-91`); service (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:12-78`); administrator (`src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:16-27`, `src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:29-49`).

### POST /internal/v1/auth/staff-accounts/:account_id/offboard

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.staffAccountLifecycle` is set; always on main.

**Request.** Path `account_id` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:3-5`). JSON body `{ "reason": "employment_ended" | "partner_firm_notice" | "security_action" }`, required (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:14-16`).

**Success.** `200 { data: { offboarded: true } }` (`src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:25-27`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authentication.staff_account_self_action_forbidden` | `account_id` is the caller's own account |
| 409 | `authentication.staff_account_target_unavailable` | No account has this id (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:80-113`) |
| 409 | `authentication.staff_account_target_invalid` | The Better Auth user is not a `staff_partner` user, so a customer account cannot be offboarded here (`src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:75-96`) |

**Notes.** In order: (1) the Better Auth user gets `disabledAt` and `disabledReason` (unless already set) and every session is deleted (`src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:51-66`, `src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:61-62`); (2) one transaction deletes the MFA rows, challenges and credentials, sets `revoked_at` on every active role assignment, sets the account to `suspended_restricted` and writes `authentication.staff_account_offboarded` with the reason and the counts (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:105-147`, `src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:128`). The call is idempotent: a second call finds nothing to revoke and writes another audit row. The Better Auth passkey rows are kept; a disabled user cannot create a session (`STAFF_ACCOUNT_DISABLED`) (`src/modules/auth/infrastructure/staff/better-auth-staff-account-guard.plugin.ts:51-56`). No route or command reverses an offboarding, and the identity's email stays taken, so the same address cannot be invited again ([../staff-access.md](../staff-access.md#known-limitations)). The call also works on a staff identity that has no active role.

**Source.** Router (`src/modules/auth/api/staff/staff-account-lifecycle.router.ts:93-105`); service (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:80-113`); repository (`src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:105-147`).

## Customer account-recovery cases

A customer who has lost access to the phone (and so to the account) is recovered through a staff-reviewed case: a fresh Didit verification, a primary review, a decision by a different reviewer, and a completion that ends every old device and session. The steps, the post-recovery cooldown and the data boundary are described in [../account-recovery.md](../account-recovery.md); that guide still describes the customer completion step as a password-reset link, which main no longer does (the entry for `POST .../complete` has the behaviour on main; see also [../authentication.md](../authentication.md#account-recovery-as-built)). The case row is `auth.account_recovery_cases` (`prisma/schema/auth.prisma:161-182`); every route returns the case in the same shape:

| Field | Type | Value |
| --- | --- | --- |
| `recovery_case_id` | string | `recovery_case_` plus a ULID |
| `account_id` | string | The customer account |
| `status` | enum | `open`, `approved`, `rejected` or `completed` |
| `fresh_didit_verification_ref` | string or null | The Didit session id; null until the Didit route runs |
| `reviewed_by_primary`, `reviewed_by_secondary` | string or null | Account ids of the primary reviewer and of the deciding reviewer |
| `cooldown_ends_at` | ISO-8601 or null | Set at completion: 72 hours later (`src/modules/auth/application/staff/account-recovery.service.ts:15`) |
| `created_at`, `resolved_at` | ISO-8601, ISO-8601 or null | `resolved_at` is set by the decision |

The shape is `accountRecoveryCaseSchema` (`src/modules/auth/api/staff/account-recovery.schemas.ts:29-39`, `src/modules/auth/api/staff/account-recovery.router.ts:131-143`). The path parameter is `case_id`, trimmed, at least 1 character (`src/modules/auth/api/staff/account-recovery.schemas.ts:3-5`). A staff account cannot be the subject of a case: staff are recovered with `POST /internal/v1/auth/staff-accounts/:account_id/recovery`.

### POST /internal/v1/account-recovery-cases

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.accountRecovery` is set; always on main.

**Request.** JSON body `{ "account_id": string }`, trimmed, at least 1 character (`src/modules/auth/api/staff/account-recovery.schemas.ts:7-9`).

**Success.** `201 { data: <case> }` with status `open`, parsed through `accountRecoveryCaseResponseSchema` (`src/modules/auth/api/staff/account-recovery.schemas.ts:41-43`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 404 | `authentication.account_recovery_target_not_found` | No account has this id (`src/modules/auth/application/staff/account-recovery.service.ts:482-489`) |
| 409 | `authentication.account_recovery_target_is_staff` | The account holds an active staff role (`src/modules/auth/application/staff/account-recovery.service.ts:491-499`) |
| 409 | `authentication.account_recovery_target_not_active` | The account status is not `active` (`src/modules/auth/application/staff/account-recovery.service.ts:501-508`) |
| 409 | `authentication.account_recovery_case_already_open` | An `open` case exists for the account (`src/modules/auth/application/staff/account-recovery.service.ts:510-517`) |
| 409 | `authentication.customer_account_target_invalid` | The Better Auth user is a staff identity although the account has no active staff role, for example a staff identity whose last role was revoked (`src/modules/auth/infrastructure/customer/better-auth-customer-account-administrator.ts:92-114`) |

**Notes.** In order: (1) the Better Auth user gets `recoveryRequiredAt` and every session is deleted; this happens before any VistaBlox row is written, so no live session can act while the case is being recorded (`src/modules/auth/application/staff/account-recovery.service.ts:42-47`, `src/modules/auth/infrastructure/customer/better-auth-customer-account-administrator.ts:13-21`); (2) one transaction inserts the case (trigger `full_lockout`, status `open`), sets the account to `recovery_review` and writes `authentication.account_recovery_case_opened` (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:64-97`); (3) an email "case opened" is sent to the customer's address when one is on file; a failure is swallowed without a log (`src/modules/auth/application/staff/account-recovery.service.ts:52-57`). From (1) on the customer's requests answer `401 authentication.required`: the sessions are gone, and a user with `recoveryRequiredAt` set resolves to no session and cannot create one (`src/modules/auth/infrastructure/shared/better-auth-session.resolver.ts:61-71`, `src/modules/auth/infrastructure/staff/better-auth-staff-account-guard.plugin.ts:57-62`). The check for an open case and the insert are separate statements and no unique index covers open cases, so two simultaneous calls can create two cases.

**Source.** Router (`src/modules/auth/api/staff/account-recovery.router.ts:42-52`); service (`src/modules/auth/application/staff/account-recovery.service.ts:18-62`); repository (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:64-97`).

### GET /internal/v1/account-recovery-cases/:case_id

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.accountRecovery` is set; always on main.

**Request.** Path `case_id`. No body.

**Success.** `200`, header `Cache-Control: no-store` (`src/modules/auth/api/staff/account-recovery.router.ts:54-67`, `src/modules/auth/api/staff/account-recovery.schemas.ts:58-64`):

| Field | Type | Value |
| --- | --- | --- |
| `data.case` | object | The case, as above |
| `data.fresh_didit_verification_status` | string or null | Didit's current status for the stored session, read live on every call; null when no session is on file |
| `data.corroboration_facts.last_deposit` | object or null | `{ amount_eur, recorded_at }` of the newest money event on any of the account's reservations |
| `data.corroboration_facts.last_reservation` | object or null | `{ amount_eur, created_at }` of the newest reservation |
| `data.corroboration_facts.last_login` | object or null | `{ auth_method, occurred_at }` of the newest mirrored session |

`amount_eur` is a decimal string with two places (`src/modules/auth/api/staff/account-recovery.schemas.ts:52-56`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:131-164`). Nothing is matched automatically; a reviewer compares these facts with what the customer states.

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 404 | `authentication.account_recovery_case_not_found` | No case has this id (`src/modules/auth/application/staff/account-recovery.service.ts:528-535`) |
| 503 | `identity.kyc_provider_unavailable` | Didit did not answer within 4 seconds or answered with an error status; only when a session is on file (`src/modules/identity/infrastructure/didit.client.ts:159-181`, `src/modules/identity/infrastructure/didit.client.ts:262-270`, `src/server.ts:385-389`) |
| 502 | `identity.kyc_provider_response_invalid` | Didit answered with a body the client cannot read (`src/modules/identity/infrastructure/didit.client.ts:272-280`) |

**Source.** Router (`src/modules/auth/api/staff/account-recovery.router.ts:54-67`); service (`src/modules/auth/application/staff/account-recovery.service.ts:100-125`); repository (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:131-164`).

### POST /internal/v1/account-recovery-cases/:case_id/didit-sessions

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.accountRecovery` is set; always on main.

**Request.** Path `case_id`. The body must be absent or an empty object (`src/modules/auth/api/staff/account-recovery.schemas.ts:11`).

**Success.** `201 { data: { verification_url, case } }`; `verification_url` is the hosted Didit URL, which staff pass to the customer out of band (`src/modules/auth/api/staff/account-recovery.schemas.ts:45-50`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.account_recovery_case_not_open` | The case does not exist or its status is not `open`; an unknown id answers 409, not 404 (`src/modules/auth/application/staff/account-recovery.service.ts:64-98`, `src/modules/auth/application/staff/account-recovery.service.ts:519-526`) |
| 503, 502 | `identity.kyc_provider_unavailable`, `identity.kyc_provider_response_invalid` | Didit failed (`src/modules/identity/infrastructure/didit.client.ts:262-270`, `src/modules/identity/infrastructure/didit.client.ts:272-280`) |

**Notes.** The Didit session uses the same workflow as baseline KYC (`DIDIT_WORKFLOW_ID`) and `DIDIT_CALLBACK_URL`, purpose `account_recovery`, and a start id `recovery_` plus a UUID (`src/server.ts:398-409`, `src/modules/auth/application/staff/account-recovery.service.ts:64-98`). The call stores the session id in `fresh_didit_verification_ref`, replacing any earlier value, and writes `authentication.account_recovery_didit_session_created` (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:99-129`). Calling it again creates a second Didit session and replaces the reference, also after the primary review was recorded.

**Source.** Router (`src/modules/auth/api/staff/account-recovery.router.ts:69-84`); service (`src/modules/auth/application/staff/account-recovery.service.ts:64-98`); repository (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:99-129`).

### POST /internal/v1/account-recovery-cases/:case_id/primary-review

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.accountRecovery` is set; always on main.

**Request.** Path `case_id`. JSON body `{ "corroboration_category": "recent_deposit" | "recent_investment" | "last_login" | "other_policy_approved" }` (`src/modules/auth/api/staff/account-recovery.schemas.ts:13-20`).

**Success.** `200 { data: <case> }` with `reviewed_by_primary` set to the caller.

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.account_recovery_primary_review_unavailable` | One answer for: unknown case, case not `open`, a primary review already recorded, or no Didit session on file (unless the staging waiver below applies) (`src/modules/auth/application/staff/account-recovery.service.ts:537-545`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:166-214`) |

**Notes.** The gate is the existence of `fresh_didit_verification_ref`, not the outcome of the Didit session (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:178`). When `ACCOUNT_RECOVERY_SKIP_DIDIT_IN_STAGING=true` (accepted only when `APP_ENV=staging`), a review is also accepted for a case with no Didit session, and the audit row carries `didit_gate_waived: true` (`src/modules/auth/application/staff/account-recovery.service.ts:146`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:185-190`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:204`, `src/config/environment.ts:564-568`). The category is recorded only in the audit row `authentication.account_recovery_primary_review_recorded`, not in the case row. Any administrator can record the primary review, including the one who opened the case.

**Source.** Router (`src/modules/auth/api/staff/account-recovery.router.ts:86-98`); service (`src/modules/auth/application/staff/account-recovery.service.ts:127-151`); repository (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:166-214`).

### POST /internal/v1/account-recovery-cases/:case_id/decision

**Auth.** Admin chain. Baseline limiter per account. Dual control: the caller must differ from the primary reviewer.

**Mounted when.** `protectedApi.accountRecovery` is set; always on main.

**Request.** Path `case_id`. JSON body `{ "decision": "approved" | "rejected", "reason": string }`, the reason trimmed, 1 to 2000 characters (`src/modules/auth/api/staff/account-recovery.schemas.ts:22-25`).

**Success.** `200 { data: <case> }` with `status` equal to the decision, `reviewed_by_secondary` the caller and `resolved_at` set.

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 404 | `authentication.account_recovery_case_not_found` | No case has this id (`src/modules/auth/application/staff/account-recovery.service.ts:153-200`) |
| 409 | `authentication.account_recovery_same_reviewer` | The caller recorded the primary review (`src/modules/auth/application/staff/account-recovery.service.ts:170-172`, `src/modules/auth/application/staff/account-recovery.service.ts:547-554`) |
| 409 | `authentication.account_recovery_decision_unavailable` | The case is not `open`, has no primary review, or the caller is the primary reviewer at the moment of the update (`src/modules/auth/application/staff/account-recovery.service.ts:556-564`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:236-239`) |
| 500 | `internal.unexpected` | Only with `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE=true`: the decision by the primary reviewer violates the database check `account_recovery_distinct_reviewers`. Read from the code and the schema; not executed (`prisma/migrations/20260831150000_initial_schema/migration.sql:940-945`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:216-270`) |

**Notes.** Dual control is enforced twice: the service refuses the primary reviewer, and the update itself carries `NOT reviewed_by_primary = <caller>`, so a race cannot slip through (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:232-240`); the schema adds the check `account_recovery_distinct_reviewers` (`prisma/migrations/20260831150000_initial_schema/migration.sql:940-945`). The reason is written to the audit row `authentication.account_recovery_case_approved` or `..._rejected` together with the primary reviewer's id and `single_reviewer_mode`; it is not stored on the case (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:216-270`). The customer gets an "approved" or "rejected" email when an address is on file; a failure is swallowed (`src/modules/auth/application/staff/account-recovery.service.ts:185-196`). A rejection is terminal for the case and leaves the account in `recovery_review`; the route restores nothing. In staging, `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE=true` (accepted only when `APP_ENV=staging`) lets the service and the update skip the same-reviewer refusal; the decision then fails at the database check and answers 500, so the mode cannot complete a decision (`src/config/environment.ts:102-105`, `src/config/environment.ts:555-559`, `src/app.ts:1009-1013`). It is issue #214; the design-record entry is C-013.

> Pending #238: removes `ACCOUNT_RECOVERY_SINGLE_REVIEWER_MODE` and the `single_reviewer_mode` audit key, so the same-reviewer refusal always applies.

**Source.** Router (`src/modules/auth/api/staff/account-recovery.router.ts:100-113`); service (`src/modules/auth/application/staff/account-recovery.service.ts:153-200`); repository (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:216-270`).

### POST /internal/v1/account-recovery-cases/:case_id/complete

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.accountRecovery` is set; always on main.

**Request.** Path `case_id`. The body must be absent or an empty object (`src/modules/auth/api/staff/account-recovery.schemas.ts:27`).

**Success.** `202 { data: <case> }` with `status: "completed"` and `cooldown_ends_at` 72 hours after the call.

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `authentication.account_recovery_case_not_approved` | The case does not exist (an unknown id answers 409, not 404), is not `approved`, or is already `completed` and belongs to a customer (`src/modules/auth/application/staff/account-recovery.service.ts:566-573`, `src/modules/auth/application/staff/account-recovery.service.ts:202-480`) |
| 503 | `authentication.account_recovery_completion_failed` | Revoking the devices or sessions or clearing the flag failed; the case stays `approved` and the call can be repeated (`src/modules/auth/application/staff/account-recovery.service.ts:432-436`, `src/modules/auth/application/staff/account-recovery.service.ts:389-439`) |
| 503 | `authentication.account_recovery_completion_delivery_failed` | Only for a case whose account holds a staff role at completion (`src/modules/auth/application/staff/account-recovery.service.ts:342-347`, `src/modules/auth/application/staff/account-recovery.service.ts:314-374`); see [Known limitations](#known-limitations) |

**Notes.** For a customer, in order (`src/modules/auth/application/staff/account-recovery.service.ts:230-270`): (1) one transaction sets every active device of the account to `revoked` (reason `account_recovery`), deletes its `device_key` login methods and writes `authentication.device_revoked` per device and `authentication.login_method_removed` (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:311-377`); (2) every remaining session is deleted, device sessions included, and `authentication.account_recovery_sessions_revoked` records the counts; (3) `recoveryRequiredAt` is cleared and `authentication.account_recovery_restriction_cleared` is written; (4) one transaction sets the case to `completed` with the cooldown, sets the account to `active` and writes `authentication.account_recovery_completed` (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:272-309`); (5) an email without a link tells the customer to sign in with Google or Apple and set the phone up again, and `authentication.account_recovery_reenrolment_notice` records `sent`, `failed` or `no_contact_email` (`src/modules/auth/application/staff/account-recovery.service.ts:446-479`). The customer re-enrols a device through the ordinary ceremonies ([auth-customer.md](auth-customer.md)). While `cooldown_ends_at` is in the future, reservation creation is blocked with the blocker `recovery_cooldown_active` (`src/modules/offering/repository/prisma-offering.repository.ts:437-440`, `src/modules/offering/domain/reservation-eligibility.policy.ts:202-204`). A second `complete` for a customer case answers 409.

**Source.** Router (`src/modules/auth/api/staff/account-recovery.router.ts:115-126`); service (`src/modules/auth/application/staff/account-recovery.service.ts:202-480`); repository (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:272-309`).

## Customer account-closure review

A customer asks to close the account with `POST /v1/auth/account-closure` ([auth-customer.md](auth-customer.md)); staff review the pending requests here. The request row is `auth.account_closure_requests` (`prisma/schema/auth.prisma:189-205`). Review is single-reviewer by design: there is no second approver.

### GET /internal/v1/account-closure-requests

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.accountClosure` is set; always on main.

**Request.** No parameters.

**Success.** `200 { data: [ ... ] }`, header `Cache-Control: no-store`, parsed through `listPendingAccountClosureRequestsResponseSchema` (`src/modules/auth/api/shared/account-closure.schemas.ts:31-33`, `src/modules/auth/api/shared/account-closure.schemas.ts:16-25`). Each item has `closure_request_id`, `account_id`, `status` (`pending`, `approved`, `rejected` or `cancelled`), `reason` (the customer's text or null), `requested_at`, `resolved_at`, `resolved_by` and `resolution_note` (the last three null while pending).

**Errors.** None beyond the common ones.

**Notes.** Only `pending` requests, oldest first, unpaginated (`src/modules/auth/repository/shared/prisma-account-closure.repository.ts:84-90`).

**Source.** Router (`src/modules/auth/api/staff/account-closure-operations.router.ts:26-32`); service (`src/modules/auth/application/shared/account-closure.service.ts:53-59`); repository (`src/modules/auth/repository/shared/prisma-account-closure.repository.ts:84-90`).

### POST /internal/v1/account-closure-requests/:request_id/decision

**Auth.** Admin chain. Baseline limiter per account.

**Mounted when.** `protectedApi.accountClosure` is set; always on main.

**Request.** Path `request_id`, trimmed, at least 1 character (`src/modules/auth/api/shared/account-closure.schemas.ts:12-14`). JSON body `{ "decision": "approved" | "rejected", "note"?: string }`, the note trimmed, 1 to 2000 characters (`src/modules/auth/api/shared/account-closure.schemas.ts:7-10`).

**Success.** `200 { data: <request> }` with the new status, `resolved_at`, `resolved_by` (the caller) and `resolution_note` (`src/modules/auth/api/shared/account-closure.schemas.ts:27-29`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 409 | `account_closure.request_not_pending` | The request does not exist or is already resolved or cancelled (`src/modules/auth/application/shared/account-closure.service.ts:135-142`) |
| 404 | `account_closure.target_not_found` | Approval only: the account of the request no longer exists (`src/modules/auth/application/shared/account-closure.service.ts:99-106`) |
| 409 | `authentication.customer_account_target_invalid` | Approval only: the Better Auth user is a staff identity (`src/modules/auth/infrastructure/customer/better-auth-customer-account-administrator.ts:92-114`) |

**Notes.** Approval, in order: (1) the Better Auth user gets `recoveryRequiredAt` and every session is deleted (`src/modules/auth/application/shared/account-closure.service.ts:77-84`, `src/modules/auth/infrastructure/customer/better-auth-customer-account-administrator.ts:13-21`); (2) one transaction sets the request to `approved`, sets the account to `suspended_restricted` and writes `authentication.customer_account_closed` with the request id and the note (`src/modules/auth/repository/shared/prisma-account-closure.repository.ts:92-138`). Rejection writes `authentication.customer_closure_request_rejected` and changes nothing else. Approval revokes no device and sends no email. Step (1) runs before the conditional update in (2); a request that was resolved in between answers 409 after the customer's sessions were already deleted and the flag set ([Known limitations](#known-limitations)).

**Source.** Router (`src/modules/auth/api/staff/account-closure-operations.router.ts:34-46`); service (`src/modules/auth/application/shared/account-closure.service.ts:61-97`); repository (`src/modules/auth/repository/shared/prisma-account-closure.repository.ts:92-138`).

## Audit rows written by these routes

Every row is in `audit.audit_log` (`prisma/schema/schema.prisma:1065-1083`); `actor_account_id` is the caller unless noted. Each row's `changes` carries `trace_id`, except the two closure rows, whose `changes` hold only `closure_request_id` and `note` (`src/modules/auth/repository/shared/prisma-account-closure.repository.ts:129-132`).

| Action | Written by | Resource |
| --- | --- | --- |
| `authentication.staff_invitation_issued` | invitation issue | `staff_invitation` |
| `authentication.staff_invitation_revoked` | email delivery failed (reason `delivery_failed`); the bootstrap command (reasons `bootstrap_reissued`, `superseded_by_bootstrap`, no actor) | `staff_invitation` |
| `authentication.staff_invitation_accepted` | invitation accept (actor: the new account) | `staff_invitation` |
| `authentication.staff_webauthn_credential_registered` | WebAuthn registration verify | `account` |
| `authentication.staff_webauthn_challenge_succeeded`, `authentication.staff_webauthn_challenge_failed` | WebAuthn authentication verify; registration verify (failure only) | `session` |
| `authentication.staff_role_granted`, `authentication.staff_role_revoked` | role grant and revoke | `account` |
| `authentication.staff_account_recovery_started`, `authentication.staff_account_recovery_delivery_failed` | staff recovery | `account` |
| `authentication.staff_account_offboarded` | offboarding | `account` |
| `authentication.account_recovery_case_opened`, `..._didit_session_created`, `..._primary_review_recorded`, `..._case_approved`, `..._case_rejected`, `..._completed` | the recovery case routes | `account_recovery_case` |
| `authentication.account_recovery_sessions_revoked`, `..._restriction_cleared`, `..._reenrolment_notice` (customer); `..._link_sent`, `..._link_delivery_failed` (staff-target branch) | recovery completion | `account_recovery_case` |
| `authentication.device_revoked`, `authentication.login_method_removed` | recovery completion (customer) | `device`, `account` |
| `authentication.customer_account_closed`, `authentication.customer_closure_request_rejected` | closure decision | `account` |

A read leaves no audit row: `GET /internal/v1/auth/staff-accounts`, `GET /internal/v1/account-recovery-cases/:case_id` and `GET /internal/v1/account-closure-requests` write nothing. The session rows that the deletions in recovery, offboarding and closure produce (`authentication.session_revoked`) come from the Better Auth audit plugin (`src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:231-248`).

## Known limitations

Defects and sharp edges found while reading the code. They are stated as found and are not fixed here. The model-level limitations (sole administrator, offboarding, staff sessions) are in [../staff-access.md](../staff-access.md#known-limitations).

| # | Finding | Evidence | Issue |
| --- | --- | --- | --- |
| 1 | **An unknown practice or firm id ends in a 500.** `POST /internal/v1/auth/staff-invitations` and `POST .../roles` never look the organisation up, and the foreign keys reject the insert; the error handler answers `500 internal.unexpected`. The status of the organisation (`active` or `suspended`) is not checked either. Read from the code and the schema; not executed | (`src/modules/auth/application/staff/staff-invitation.service.ts:39-50`, `prisma/migrations/20260831180000_staff_invitations/migration.sql:57-62`, `src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:187-234`, `prisma/migrations/20260831150000_initial_schema/migration.sql:750-753`, `src/modules/intake/application/operations-case.service.ts:561`, `src/modules/intake/application/operations-case.service.ts:568`) | none found |
| 2 | **The staging single-reviewer mode cannot complete a decision.** The mode removes the same-reviewer refusal, and the database check `account_recovery_distinct_reviewers` then rejects the update; the API answers 500 | (`src/config/environment.ts:102-105`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:216-270`, `prisma/migrations/20260831150000_initial_schema/migration.sql:940-945`) | #214 (PR #238); design record C-013 |
| 3 | **A recovery case does not require the Didit verification to have succeeded.** The primary review, the decision and the completion need only that a Didit session id is on file; the status is shown by the read route and nothing reads it in code | (`src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:178`, `src/modules/auth/application/staff/account-recovery.service.ts:100-125`) | none found |
| 4 | **Completing a recovery case whose account holds a staff role cannot send its link.** The branch sends through the customer administrator, which refuses a staff identity, so the call answers `503 ...completion_delivery_failed`. The branch is reachable only if an account gains a staff role while its case is open, and no route does that (role grants need an existing staff role; invitations create new identities). The existing guide describes this branch as working | (`src/modules/auth/application/staff/account-recovery.service.ts:250-268`, `src/modules/auth/infrastructure/customer/better-auth-customer-account-administrator.ts:46-67`, `src/modules/auth/infrastructure/customer/better-auth-customer-account-administrator.ts:53`, `src/server.ts:400`) | none found |
| 5 | **Closure approval deletes the customer's sessions before the conditional update.** If another reviewer rejected the request, or the customer cancelled it, in between, the call answers 409 but the sessions are gone and `recoveryRequiredAt` is set while the account stays `active`; the customer cannot sign in until a recovery case clears the flag | (`src/modules/auth/application/shared/account-closure.service.ts:77-84`, `src/modules/auth/application/shared/account-closure.service.ts:94`, `src/modules/auth/repository/shared/prisma-account-closure.repository.ts:92-138`) | none found |
| 6 | **Check-then-insert without a unique index.** Two simultaneous role grants of the same role, or two simultaneous case openings for one account, can both succeed | (`src/modules/auth/application/staff/staff-account-lifecycle.service.ts:150-154`, `src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:187-234`, `src/modules/auth/application/staff/account-recovery.service.ts:31-37`, `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:64-97`) | none found |
| 7 | **Unknown ids answer 404 on two routes and 409 on three.** `GET` and `decision` answer 404 `..._case_not_found`; `didit-sessions`, `primary-review` and `complete` answer 409 for an unknown case id | (`src/modules/auth/application/staff/account-recovery.service.ts:528-535`, `src/modules/auth/application/staff/account-recovery.service.ts:519-526`, `src/modules/auth/application/staff/account-recovery.service.ts:537-545`, `src/modules/auth/application/staff/account-recovery.service.ts:566-573`) | none found |
| 8 | **The email-sending routes have no cooldown.** Invitation issue and staff recovery send one email per call and are limited only by the baseline limiter (300 per minute per account); the SMTP transport sets no explicit timeouts (library defaults apply, see the invitation entry) | (`src/modules/auth/application/staff/staff-invitation.service.ts:53-74`, `src/modules/auth/infrastructure/staff/better-auth-staff-account-administrator.ts:29-49`, `src/infrastructure/email/smtp-email-sender.ts:88-93`) | none found |
| 9 | **The limiters let requests through when the store errors.** The tight cap (10 per minute) on invitation accept and the WebAuthn step-up routes, and the baseline cap (300 per minute) on authenticated routes, are skipped while the rate-limit store returns an error; the request is let through with a warning, `rate limit store unavailable; allowing request`. Neither exists without a store. The production policy is not decided. Read from the code, not executed | (`src/shared/http/rate-limit.ts:55-61`, `src/shared/http/rate-limit.ts:23-27`) | #175 (needs a founder decision) |

## Not verified

* **Admin console behaviour.** The console is not in this repository. How it reads the `token` of an invitation link and the `context` of a recovery link, and which origin it runs on, is taken from the code that builds the links and from the environment comments, not from the console.
* **Better Auth passkey routes.** The `@better-auth/passkey` package (version 1.7.2, `package-lock.json:495-497`) is not installed in the worktree. The parameters of `/api/auth/passkey/*` are described as far as this repository's code and tests show them (`tests/better-auth-passkey-related-origins.test.ts:109-134`, `tests/better-auth-passkey-related-origins.test.ts:151-176`) and as read from the source of that version in an installed copy, not run; they are covered in [better-auth.md](better-auth.md) and, for the staff flows, in [../staff-access.md](../staff-access.md#what-the-pinned-passkey-plugin-does). The plugin creates a session at registration only when the request body sets `createSession: true`; the repository's test, which does not set it, finds none until the separate sign-in (`tests/better-auth-passkey-related-origins.test.ts:240-255`).
* **Behaviour that is inferred from constraints and code.** Entries 1, 2, 4, 5 and 6 above, and the 500 of the WebAuthn authentication verify route, were read from the code and the schema; no request was run, no test was run and no database ran.
* **Email delivery.** No message was sent. On staging, `docker-compose.staging.yml` forces `SMTP_HOST` to the mail catcher `maildev`, so staging invitation and recovery emails do not reach real inboxes (`docker-compose.staging.yml:242-247`, `docker-compose.staging.yml:22-24`). What production uses is not in the repository.
* **Staging and production configuration.** `.env.staging` is not in the repository and no production configuration was seen: which of `STAFF_INVITATION_ACCEPT_URL`, `STAFF_RECOVERY_REDIRECT_URL`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_ID` and `RATE_LIMIT_CACHE_URL` are set where is unknown.
* **Behaviour on PostgreSQL 18.** Not checked. No database was used for this chapter; the project's local checks ran on 16.15.
* **Real Didit behaviour.** The recovery routes were read against the client code; no real Didit session was created or read.

## Related documents

* [../staff-access.md](../staff-access.md): the staff model, the guards, the role matrix
* [../account-recovery.md](../account-recovery.md): the customer recovery guide (its completion step is out of date, see above)
* [../authentication.md](../authentication.md), [auth-customer.md](auth-customer.md), [better-auth.md](better-auth.md), [README.md](README.md)
* [../cli.md](../cli.md): the first-admin bootstrap command
* [../data-model.md](../data-model.md), [../security.md](../security.md), [../configuration.md](../configuration.md)
* [intake-staff.md](intake-staff.md), [offering.md](offering.md), [wallet.md](wallet.md), [platform.md](platform.md)
