# Module: account

Valid for main at 48aa967 (2026-11-18).

The `account` module owns the local account record: the row in `account.accounts` that every other module keys on, the mapping from a Better Auth user to that row, the read-side questions "does this account hold a staff role?" and "which partner organisation does it act for?", and the staff search of accounts by email. Read this page before you change how an account is created, looked up or classified, or before you add a field that every request needs about the caller.

## 1. Purpose and bounded context

| Question | Answer |
| --- | --- |
| What is an account? | The VistaBlox-side identity of one person. It is created when Better Auth creates a user, holds a status and a verified contact email, and is referenced by `account_id` from reservations, KYC rows, wallet registrations, sessions, devices and more (`prisma/schema/schema.prisma:11-67`). |
| What does the module own? | Creating the account row from a Better Auth user event, syncing the verified email, recording which login method was used, answering staff-role and partner-organisation questions, and `GET /internal/v1/accounts` (`src/modules/account/application/account-provisioner.ts:5-37`, `src/modules/account/api/account.router.ts:15-19`). |
| What does it not own? | Authentication, sessions, DPoP, devices, staff invitations, recovery and closure (module `auth`); KYC state (`identity`); display preferences (`profile`). It never changes `status` after creation: the transitions to `recovery_review`, `suspended_restricted` and back to `active` are written by the `auth` module (section 5). |
| Population | Customers and staff are both rows in `account.accounts`. The population (customer or `staff_partner`) is not stored here; it is a field of the Better Auth user, read by `src/modules/auth/infrastructure/shared/better-auth-session.resolver.ts:77` and placed in `response.locals.authContext` by `src/modules/auth/api/shared/require-authentication.ts:86-95`. |

## 2. File map

| Layer | File | Lines | Responsibility |
| --- | --- | --- | --- |
| api | `src/modules/account/api/account.router.ts` | 22 | `createAccountSearchRouter(requireAuthentication, requireAdminOperations, requireStaffWebAuthn, searchAccounts)`: one route, `GET /`, guarded by the three injected middlewares. |
| api | `src/modules/account/api/account.schemas.ts` | 17 | `searchAccountsQuerySchema` (`email`, trimmed, 1 to 320 characters), `accountSummarySchema` (`account_id`, `email` or `null`, `status`), `searchAccountsResponseSchema` (`{ data: [...] }`). |
| application | `src/modules/account/application/account-provisioner.ts` | 37 | `AccountProvisioner`: `onUserCreated`, `onUserUpdated`, `onLoginMethodUsed`. Called from Better Auth database hooks, not from a route. |
| application | `src/modules/account/application/search-accounts.service.ts` | 16 | `SearchAccountsByEmailService.execute(email)`: maps repository rows to the wire shape. |
| domain | none | | The module has no `domain/` directory and no policy class. |
| repository | `src/modules/account/repository/account.repository.ts` | 51 | Interface `AccountRepository`, the types `AccountStatus`, `LoginMethodType`, `LocalAccountContext`, `AccountSummary`. |
| repository | `src/modules/account/repository/prisma-account.repository.ts` | 139 | `PrismaAccountRepository`, the only implementation. Its `asAccountStatus` throws `Unknown account status: <value>` for a value other than the three known ones (`src/modules/account/repository/prisma-account.repository.ts:130-139`). |

Wiring: `src/server.ts:135` builds `PrismaAccountRepository`; `src/server.ts:141` builds `AccountProvisioner`; `src/app.ts:1068-1076` mounts the search router at `/internal/v1/accounts`.

> Pending #237: the `/internal/v1/accounts` mount moves from `src/app.ts` into `src/composition/compose-account.ts`; the router, service and repository do not change.

## 3. Public surface

### 3.1 Routes

The full entry is in [../api/platform.md](../api/platform.md) (section "Accounts (staff)").

| Method | Path | Authentication | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/internal/v1/accounts?email=<address>` | `requireAuthentication`, then `requireAdminOperations`, then `requireStaffWebAuthn` (`src/modules/account/api/account.router.ts:13`) | Returns every account whose `protected_contact_email` equals the address, ignoring case, oldest first. There is no pagination and no limit; the repository comment says none is needed at the current volume (`src/modules/account/repository/account.repository.ts:17-22`, `src/modules/account/repository/prisma-account.repository.ts:28-39`). A missing or blank `email` is `422 validation.invalid_field` (`src/modules/account/api/account.schemas.ts:3-5`; test `tests/staff-intake-case-creation-api.test.ts`, "rejects a missing email query parameter"). |

> Pending #245: the router sends its body through `sendValidated`, so a body that fails `searchAccountsResponseSchema` becomes `500 internal.response_invalid` instead of `422 validation.invalid_field`.

The request logger masks the query value of `email`, so a customer address does not reach the log (`src/infrastructure/logging/request-log-redaction.ts:11-12`; test `tests/request-logging-api.test.ts`, "?email=[REDACTED]").

### 3.2 Hooks called by Better Auth

These are the module's other entry points. They are wired in `src/server.ts` into two Better Auth instances:

| Hook | Called when | What it does | Wired at |
| --- | --- | --- | --- |
| `AccountProvisioner.onUserCreated` | Better Auth `databaseHooks.user.create.after` (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:258-260`) | `provision`: `upsert` on `better_auth_user_id` with an empty update, so a second call does nothing; the new row gets id `acct_<ulid>` and the user's email only when `emailVerified` is true, else `null` (`src/modules/account/application/account-provisioner.ts:8-13`, `src/modules/account/repository/prisma-account.repository.ts:72-88`). | `src/server.ts:357` (customer instance), `src/server.ts:378` (staff provisioning instance) |
| `AccountProvisioner.onUserUpdated` | `databaseHooks.user.update.after` (`src/modules/auth/infrastructure/shared/better-auth.factory.ts:262-266`) | Does nothing unless the user's email is verified; then overwrites `protected_contact_email` (`src/modules/account/application/account-provisioner.ts:15-23`). The update throws if no account row exists yet (`src/modules/account/repository/prisma-account.repository.ts:94-97`). | `src/server.ts:358`, `src/server.ts:379` |
| `AccountProvisioner.onLoginMethodUsed` | The Better Auth audit plugin, on a session created by a login path whose method is `passkey`, `google` or `apple` (`src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:196-207`, `src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:443-445`) | `recordLoginMethod`: upserts `auth.login_methods` on `(account_id, method_type)`, empty update, with `provider_subject` set to the Better Auth user id and `linked_via_fresh_auth` true (`src/modules/account/repository/prisma-account.repository.ts:100-127`). An error is passed to `options.onError`, not thrown (`src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:204-206`). | `src/server.ts:359` (customer instance only) |

The device-key login method (`device_key`) is not written here: enrolment writes it from the `auth` module (`src/modules/auth/repository/customer/prisma-device.repository.ts:20-22`, `:102`).

### 3.3 Repository methods used by other modules

Other modules receive `AccountRepository` by injection and call these (declared in `src/modules/account/repository/account.repository.ts:15-51`):

| Method | Caller | Purpose |
| --- | --- | --- |
| `findByBetterAuthUserId` | `src/modules/auth/api/shared/require-authentication.ts:68`; `src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:113`, `:257` | Map a session's user to `{ accountId, status }`. A missing row is `500 account.mapping_missing`; a status other than `active` is `403 account.restricted` (`src/modules/auth/api/shared/require-authentication.ts:69-84`). |
| `hasActiveStaffRole(accountId, role)` | `src/modules/auth/api/staff/require-staff-role.ts:24`, `:65` | True when an `auth.staff_role_assignments` row for the role has `revoked_at` null. |
| `hasAnyActiveStaffRole(accountId)` | `src/modules/auth/api/staff/require-staff-role.ts:83` | Same, for any role. |
| `getActivePartnerOrganizationId(accountId, role)` | `src/modules/intake/api/require-partner-case-assignment.ts:38`; `src/modules/intake/application/partner-case.service.ts:44` | The `legal_practice_id` or `appraisal_firm_id` of the account's active partner assignment, or null (`src/modules/account/repository/prisma-account.repository.ts:60-70`). Organisation level only; the schema has no named reviewer (comment at `src/modules/account/repository/account.repository.ts:28-32`). |

## 4. Tables

| Table | Access | Notes |
| --- | --- | --- |
| `account.accounts` | read, insert, update of `protected_contact_email` | Columns `account_id`, `better_auth_user_id` (unique), `protected_contact_email`, `status` (text, default `active`), `created_at`, `updated_at` (`prisma/schema/schema.prisma:11-17`). No check constraint limits `status` (`prisma/migrations/20260831150000_initial_schema/migration.sql:26-35`) and no index exists on `protected_contact_email`, so the email search compares every row. |
| `auth.staff_role_assignments` | read only | Roles `admin_operations`, `legal_partner`, `appraisal_partner`; a role is active while `revoked_at` is null (`prisma/schema/auth.prisma:91-108`). The column `role` is text; the database constraint `staff_role_assignment_scope` allows only these three roles and requires `legal_practice_id` for `legal_partner`, `appraisal_firm_id` for `appraisal_partner` and neither for `admin_operations` (`prisma/migrations/20260831150000_initial_schema/migration.sql:931-937`). Written by the `auth` module. |
| `auth.login_methods` | upsert | Unique on `(account_id, method_type)` and on `(method_type, provider_subject)` (`prisma/schema/auth.prisma:111-124`). |

The complete schema is in [../data-model.md](../data-model.md).

## 5. Domain rules and state

The module has no `domain/` code. The one state machine on its table is the `status` column, which this module reads and the `auth` module writes:

| From | To | Written by | Where |
| --- | --- | --- | --- |
| (new) | `active` | column default at provisioning | `prisma/schema/schema.prisma:15`, `src/modules/account/repository/prisma-account.repository.ts:76-85` |
| `active` | `recovery_review` | opening a customer recovery case | `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:82` |
| `recovery_review` | `active` | completing an approved recovery case | `src/modules/auth/repository/staff/prisma-account-recovery.repository.ts:289-292` |
| any | `suspended_restricted` | approving an account closure | `src/modules/auth/repository/shared/prisma-account-closure.repository.ts:113-117` |
| any | `suspended_restricted` | staff offboarding | `src/modules/auth/repository/staff/prisma-staff-account-lifecycle.repository.ts:126-129` |

Consequences read from the code: every route behind `requireAuthentication` refuses an account whose status is not `active` with `403 account.restricted` (`src/modules/auth/api/shared/require-authentication.ts:77-84`); the offering and profile modules read the status to compute reservation blockers and the profile view (`src/modules/offering/domain/reservation-eligibility.policy.ts:17`, `src/modules/profile/api/profile.schemas.ts:40`). The wire value set is the same three words in each of those places; the repositories each carry their own copy of the guard (`src/modules/offering/repository/prisma-offering.repository.ts:1925-1931`, `src/modules/profile/repository/prisma-profile.repository.ts:68-75`).

## 6. Interaction with other modules

| Direction | How |
| --- | --- |
| `auth` to `account` | Imports the `AccountRepository` and `LoginMethodType` types in five files (`src/modules/auth/api/shared/require-authentication.ts:3`, `src/modules/auth/api/staff/require-staff-role.ts:3`, `src/modules/auth/infrastructure/shared/better-auth.factory.ts:10`, `src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:8`, `src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:6`). These are `import type` statements into another module's `repository` directory; the architecture rule that forbids this is not triggered by type-only imports (see 11). |
| `intake` to `account` | Two `import type` of `AccountRepository` for partner-organisation lookup (`src/modules/intake/api/require-partner-case-assignment.ts:3`, `src/modules/intake/application/partner-case.service.ts:2`). |
| `account` to `auth` | `AccountProvisioner` imports the type `AuthUserSnapshot` from `src/modules/auth/infrastructure/shared/better-auth.factory.ts` (`src/modules/account/application/account-provisioner.ts:1`), the reverse direction of the previous rows. |
| Jobs | None enqueued or consumed. |
| Events | None. The module writes no audit row; Better Auth hooks and the audit plugin write the authentication audit rows. |

## 7. Configuration

The module reads no environment variable of its own. The values around it are `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` and `AUTH_TRUSTED_ORIGINS` (used by the Better Auth instances that call the hooks) and the staff WebAuthn settings; all are listed in [../configuration.md](../configuration.md).

## 8. Existing guides

None dedicated to this module. Related: [../account-recovery.md](../account-recovery.md) (the status transitions in section 5), [../staff-access.md](../staff-access.md) (roles and the staff guards that call `hasActiveStaffRole`), [../authentication.md](../authentication.md).

## 9. Tests

There is no unit or integration test file named for this module. The behaviour is covered indirectly:

| File | What it covers here |
| --- | --- |
| `tests/staff-intake-case-creation-api.test.ts` | `GET /internal/v1/accounts`: customer denied, staff denied before WebAuthn, every account sharing an email returned with the value trimmed, missing `email` rejected. |
| `tests/request-logging-api.test.ts` | The `email` query value is masked in the request log. |
| `tests/require-authentication.test.ts`, `tests/require-authentication-dpop.test.ts`, `tests/require-authentication-session-lifetime.test.ts` | Use an `AccountRepository` fake; cover the account lookup and `account.restricted`. |
| `tests/better-auth-bearer-dpop.integration.test.ts`, `tests/device-auth-router-login-verify.integration.test.ts`, `tests/customer-recovery-completion.integration.test.ts` and other `*.integration.test.ts` files that import `PrismaAccountRepository` | Real provisioning against a database. They skip unless `TEST_DATABASE_URL` is set; see [../testing.md](../testing.md). |

No test calls `AccountProvisioner` directly, and none covers the `onUserUpdated` path or the case-insensitive match against a database.

## 10. Where to put a change

| Change | Place |
| --- | --- |
| A new fact about an account that every request needs | Add it to `LocalAccountContext` and `findByBetterAuthUserId` (`src/modules/account/repository/account.repository.ts:4-7`); `src/modules/auth/api/shared/require-authentication.ts:86-95` then copies it into `authContext`. Keep the query a single indexed lookup. |
| A new staff role | The role check lives in `src/modules/account/repository/prisma-account.repository.ts:41-58` and the guard factories in `src/modules/auth/api/staff/require-staff-role.ts`; the role values are a text column, so also change the constraint `staff_role_assignment_scope` (`prisma/migrations/20260831150000_initial_schema/migration.sql:931-937`), `prisma/schema/auth.prisma:91-108` and the invitation schema (its own constraint `staff_invitations_role_scope_check`, `prisma/migrations/20260831180000_staff_invitations/migration.sql:25`). |
| A new status value | Change the three-value union in `src/modules/account/repository/account.repository.ts:1`, `asAccountStatus`, the schemas and types that repeat the list (`src/modules/account/api/account.schemas.ts:10`, `src/modules/profile/api/profile.schemas.ts:40`, `src/modules/profile/repository/profile.repository.ts:5`, `src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:47`, `src/modules/offering/repository/offering.repository.ts:86`, `src/modules/offering/domain/reservation-eligibility.policy.ts:17`) and the guards in the offering and profile repositories. Nothing enforces the list in the database. |
| Another way to find an account (by id, by name) | New method on `AccountRepository`, new service, new query parameter on the existing route. Add an index first if the lookup is not by primary key. |
| Anything about sign-in, sessions or devices | Module `auth`, not here. |

## 11. Known limitations

| Limitation | Evidence | Issue |
| --- | --- | --- |
| `provider_subject` of a `passkey`, `google` or `apple` login method is the Better Auth user id, not the provider's own subject, and `linked_via_fresh_auth` is always true. | `src/modules/account/application/account-provisioner.ts:33`, `src/modules/account/repository/prisma-account.repository.ts:118-125` | none |
| The email search is an unindexed case-insensitive scan with no limit. | `src/modules/account/repository/prisma-account.repository.ts:28-39`; no index on the column in `prisma/schema/schema.prisma:11-67` or the migrations | none |
| `protected_contact_email` is not unique, so two accounts can share an address and the search returns both. | `src/modules/account/repository/account.repository.ts:17-19` | none |
| Other modules import this module's `repository` types, and this module imports a type from `auth/infrastructure`. The dependency-cruiser configuration does not set `tsPreCompilationDeps`, so type-only imports are not checked and `npm run architecture` does not report them. | `dependency-cruiser.config.cjs:1-35`; import sites in section 6 | #122 (closed by #202; the work is listed as not done) |
| The three account status values are declared separately in seven types and schemas and checked by three runtime guards (`asAccountStatus` in the account, offering and profile repositories), with no shared definition. | `src/modules/account/repository/account.repository.ts:1`, `src/modules/account/api/account.schemas.ts:10`, `src/modules/profile/api/profile.schemas.ts:40`, `src/modules/profile/repository/profile.repository.ts:5`, `src/modules/auth/api/staff/staff-account-lifecycle.schemas.ts:47`, `src/modules/offering/repository/offering.repository.ts:86`, `src/modules/offering/domain/reservation-eligibility.policy.ts:17`; guards `src/modules/account/repository/prisma-account.repository.ts:130-139`, `src/modules/offering/repository/prisma-offering.repository.ts:1923-1934`, `src/modules/profile/repository/prisma-profile.repository.ts:66-77` | none |

## 12. Known gaps between the code and the design record

- `account.accounts` matches the record's column list (`04-Engineering/DATA/CORE_TABLES.md:28-34`; `prisma/migrations/20260831150000_initial_schema/migration.sql:26-35`).
- The record defines `staff_role_assignments` and `login_methods` in schema `account` (`04-Engineering/DATA/CORE_TABLES.md:41`, `:57`); the code keeps both in schema `auth` since the migration `prisma/migrations/20260909110000_separate_auth_schema/migration.sql:14`, `:18`. The record's `login_methods.method_type` comment lists `google | email_password` (`04-Engineering/DATA/CORE_TABLES.md:60`); the code writes `passkey`, `google`, `apple` and `device_key` (section 3.2). No entry in `00-Governance/MIGRATION/CONFLICT_REGISTER.md` (C-006 to C-024 searched) records either difference; it is listed as G2 in [../data-model.md](../data-model.md).

Not verified: the remaining account definitions of `CORE_TABLES.md` were not compared for this page.

## 13. Not verified

- Whether production data holds two accounts with the same `protected_contact_email`.
- Behaviour of the case-insensitive match (`mode: "insensitive"`) on PostgreSQL 18; local checks ran on 16.15.
- Why `npm run architecture` is reported clean with the type imports listed in section 6: it was not re-run for this page (no `node_modules` in the documentation worktree).
