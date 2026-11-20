# Module: profile

Valid for main at 48aa967 (2026-11-18).

The `profile` module assembles the signed-in customer's own profile from data that other modules own, and stores the customer's notification and locale preferences. It owns one table (`account.account_preferences`) and two routes. Read this page when you add a field to the profile response, change what "ready to invest" means on the profile, or need to know which module a profile field comes from.

## 1. Purpose and bounded context

| Question | Answer |
| --- | --- |
| What does the module own? | `GET /v1/investor-profile` (a read-only aggregate) and `PATCH /v1/investor-profile/preferences` (the only write); the table `account.account_preferences` (`prisma/schema/schema.prisma:70-83`). |
| What does it only read? | The account row and linked login methods (`account`/`auth`), the KYC eligibility snapshot (`identity`), the wallet registration status (`wallet`), reservation and position counts (`investor-activity`), a pending account-closure request (`auth`), and the verified display name (`identity`, through a cache). Each is read through a narrow port, not through the owning module's service (section 6). |
| Who may call it? | Customers only. A staff or partner session passes `requireAuthentication` and is then refused in the handler with `403 authorization.forbidden` (`src/modules/profile/api/profile.router.ts:51-58`). |
| What it deliberately does not do | It writes nothing but preferences. It stores no name: the verified display name is read from Didit through `identity` and a Redis cache and is never persisted in PostgreSQL (`docs/investor-profile.md`, section "Verified display-name cache"). |

## 2. File map

| Layer | File | Lines | Responsibility |
| --- | --- | --- | --- |
| api | `src/modules/profile/api/profile.router.ts` | 60 | `createProfileRouter(requireAuthentication, getProfile, updateAccountPreferences)`. `GET /` and `PATCH /preferences`. `requireCustomerContext` enforces the customer population (`:40-60`). Both responses set `Cache-Control: no-store` (`:21`, `:34`). |
| api | `src/modules/profile/api/profile.schemas.ts` | 125 | `profileResponseSchema` (the whole aggregate, `:37-109`), `accountPreferencesSchema`, `updateAccountPreferencesBodySchema` (at least one field, `:111-121`), `updateAccountPreferencesResponseSchema`. `localeSchema` accepts what `new Intl.Locale(value)` accepts, 2 to 35 characters (`:5-15`); `timezoneSchema` accepts what `new Intl.DateTimeFormat(undefined, { timeZone })` accepts (`:20-27`). |
| application | `src/modules/profile/application/get-profile.service.ts` | 117 | `GetProfileService.execute(accountId)`: reads the record, asks the display-profile port, derives `proof_of_address_status`, `investment_eligible` and the readiness flags, shapes the response. |
| application | `src/modules/profile/application/update-account-preferences.service.ts` | 23 | `UpdateAccountPreferencesService.execute(accountId, patch)` and `toPreferencesPayload`. |
| application | `src/modules/profile/application/protected-display-profile.ts` | 11 | The port `ProtectedDisplayProfileProvider.get({ accountId, diditReference, providerStatus })`; re-exports the `ProtectedDisplayProfile` type from `src/infrastructure/cache/protected-profile-cache.ts`. |
| domain | none | | No `domain/` directory. The two derived rules in section 5 are inside `GetProfileService`. |
| repository | `src/modules/profile/repository/profile.repository.ts` | 37 | `ProfileRepository.get(accountId)` and the `ProfileRecord` shape. |
| repository | `src/modules/profile/repository/prisma-profile.repository.ts` | 86 | `PrismaProfileRepository`: one account query plus four injected readers, run with `Promise.all` (`:19-46`). Throws on an unknown account status or login method (`:66-86`). |
| repository | `src/modules/profile/repository/account-preferences.repository.ts` | 27 | `AccountPreferencesSnapshot`, `defaultAccountPreferences` (`:12-18`), `AccountPreferencesRepository.update`. |
| repository | `src/modules/profile/repository/prisma-account-preferences.repository.ts` | 28 | `PrismaAccountPreferencesRepository.update`: one `upsert` that creates the row from the defaults plus the patch (`:15-26`). |
| adapter (outside the module) | `src/infrastructure/profile/identity-display-profile.provider.ts` | 50 | `IdentityDisplayProfileProvider` implements the display-profile port with `identity`'s `GetKycDisplayProfileService`. It returns `null` without a call unless the account has a Didit reference and the provider status is `Approved` (`src/infrastructure/profile/identity-display-profile.provider.ts:27-29`), and returns `null` after reporting the error when the lookup throws (`src/infrastructure/profile/identity-display-profile.provider.ts:40-48`). |

Wiring: `src/server.ts:569-577` builds the repositories (the profile repository receives the KYC, wallet, investor-activity and account-closure repositories as readers), `src/server.ts:631-635` passes them to `createApp`, and `src/app.ts:718-728` mounts the router at `/v1/investor-profile`. The investor-activity and wallet routers are mounted on the same prefix and sub-prefix by their own modules (`src/app.ts:875-885`, `:837-863`).

> Pending #237: the profile mount moves from `src/app.ts` into `src/composition/compose-investor-profile.ts`, together with the wallet and investor-activity mounts; the router, services and repositories do not change.

## 3. Public surface

### 3.1 Routes

Full entries are in [../api/platform.md](../api/platform.md) (sections "Investor profile").

| Method | Path | Authentication | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/v1/investor-profile` | session, customer population | Returns `{ data: { account_id, account_status, contact_email, member_since, display_profile, login_methods, kyc, investment_summary, readiness, wallet, preferences, pending_closure_request } }` (`src/modules/profile/api/profile.schemas.ts:37-109`). `404 investor_profile.not_found` when the account row is gone (`src/modules/profile/application/get-profile.service.ts:15-22`). |
| `PATCH` | `/v1/investor-profile/preferences` | session, customer population | Body: any of `deal_alerts_email`, `statements_email`, `marketing_email` (booleans), `locale`, `timezone`; at least one. Only the supplied fields change; the response is the full preference set (`src/modules/profile/api/profile.router.ts:24-36`). An empty body, an unknown IANA zone or an invalid locale is `422 validation.invalid_field`. The route is not rate limited beyond the baseline limiter inside `requireAuthentication` and does not require fresh authentication. |

> Pending #244: the profile router sends its body through `sendValidated`, so a body that fails its response schema becomes `500 internal.response_invalid` instead of `422 validation.invalid_field`.

### 3.2 Jobs, queues, CLI, events

None. The module enqueues nothing and consumes no queue. It writes no audit row; a preference change is not audited.

## 4. Tables

| Table | Access | Notes |
| --- | --- | --- |
| `account.account_preferences` | read (through the account relation), insert, update | Columns `account_id` (key), `deal_alerts_email` (default true), `statements_email` (true), `marketing_email` (false), `locale` (`en-US`), `timezone` (`UTC`), `updated_at` (`prisma/schema/schema.prisma:70-83`). A missing row is read as the defaults (`src/modules/profile/repository/prisma-profile.repository.ts:60`); the first `PATCH` creates it (`src/modules/profile/repository/prisma-account-preferences.repository.ts:15-26`). |
| `account.accounts` | read | `account_id`, `status`, `protected_contact_email`, `created_at` (`src/modules/profile/repository/prisma-profile.repository.ts:19-41`). |
| `auth.login_methods` | read | Ordered by `linked_at`, then `login_method_id`; the first row is reported as the registration method (`src/modules/profile/repository/prisma-profile.repository.ts:27-30`, `src/modules/profile/application/get-profile.service.ts:62-71`). |
| read through ports | | `identity.kyc_eligibility` (`KycEligibilityReader`), `settlement.wallet_registrations` (`WalletStatusReader`), `offering.reservations` and `settlement.position_ledger` (`InvestorActivitySummaryReader`), `auth.account_closure_requests` (`PendingClosureRequestReader`). |

The model definitions are in [../data-model.md](../data-model.md).

## 5. Domain rules

There is no `domain/` directory; these rules live in `GetProfileService`:

| Rule | Where |
| --- | --- |
| `proof_of_address_status` is reported as `expired` when the stored status is `current` and `proof_of_address_current_until` is at or before now; without a KYC row it is `not_started`. | `src/modules/profile/application/get-profile.service.ts:29-34` |
| `readiness.investment_eligible` is true only when the account is `active`, the KYC state is `eligible`, `renewal_due_at` is in the future, a `device_key` login method exists, and a `google` or `apple` login method exists. | `src/modules/profile/application/get-profile.service.ts:38-46` |
| `readiness.payment_account_ready` is true when any wallet registration row exists (pending or confirmed); `readiness.payout_account_verified` is true when it is confirmed. `wallet.status` is `not_registered`, `pending` or `registered` on the same basis. | `src/modules/profile/application/get-profile.service.ts:87-105` |
| `display_profile` is `null` unless the account has a Didit reference, the provider status is `Approved`, and the lookup succeeded. | `src/infrastructure/profile/identity-display-profile.provider.ts:22-49`, `src/modules/profile/application/get-profile.service.ts:23-27` |
| A pending claim whose registration expired is not counted: the wallet reader ignores rows with `expired_at` set. | `src/modules/wallet/repository/prisma-wallet.repository.ts:278-283` |

The investing rule on the profile (`investment_eligible`) is a second copy of the offering module's rule: `isLoginMethodsComplete` and `isKycCurrent` in `src/modules/offering/domain/reservation-eligibility.policy.ts:33-55` and `:57-63`. The comment at `src/modules/profile/application/get-profile.service.ts:43-44` names the offering rule. The profile flag does not include the reservation blockers that depend on an offering (wallet provisioning, disclosure pack, escrow, cooldown); those are on the offering detail (`reservation_blockers`), see [offering.md](offering.md).

## 6. Interaction with other modules

| Other module | How | Mechanism |
| --- | --- | --- |
| `identity` | KYC snapshot and display name | `KycEligibilityReader` type imported from `src/modules/identity/repository/kyc-eligibility-reader.ts` (`src/modules/profile/repository/prisma-profile.repository.ts:3`), met by the shared `PrismaKycRepository` instance (`src/server.ts:573`). The display name goes through `src/infrastructure/profile/identity-display-profile.provider.ts`, a composition-level adapter that calls identity's `GetKycDisplayProfileService`. |
| `wallet` | wallet registration status | `WalletStatusReader` type from `src/modules/wallet/repository/wallet.repository.ts` (`src/modules/profile/repository/prisma-profile.repository.ts:5`), met by `PrismaWalletRepository` (`src/server.ts:574`). |
| `investor-activity` | counts | `InvestorActivitySummaryReader` type from `src/modules/investor-activity/repository/investor-activity.repository.ts` (`:4`), met by `PrismaInvestorActivityRepository` (`src/server.ts:575`). |
| `auth` | pending closure request | `PendingClosureRequestReader` type from `src/modules/auth/repository/shared/account-closure.repository.ts` (`:2`), met by the account-closure repository (`src/server.ts:576`). |
| `offering` | none by import | The investing rule is copied (section 5). |
| Jobs | none | Nothing crosses a module boundary through pg-boss. |

All four reads are `import type` statements from another module's `repository` directory, not job calls. AGENTS.md routes cross-domain state changes through jobs; these are reads, and the architecture check does not see type-only imports (section 11).

## 7. Configuration

| Variable | Effect on this module |
| --- | --- |
| `PROFILE_CACHE_URL` | Redis or TLS Redis URL of the display-name cache. Unset: no cache client is built. Unreachable at start-up: a warning is logged and no cache is used. In both cases display names are omitted (`display_profile: null`) and cache invalidation is skipped; the request does not fail (`src/server.ts:165-188`, `src/config/environment.ts:204-212`, `src/modules/identity/application/kyc-display-profile.service.ts:41-42`). |
| `DIDIT_*` | Used by `identity` to fetch the verified name when the cache has no usable entry. |

The full list is in [../configuration.md](../configuration.md).

## 8. Existing guide

[../investor-profile.md](../investor-profile.md) describes the aggregate, the cache and the wallet registration flow. It is out of date on three points the code settles (section 11).

## 9. Tests

| File | What it covers |
| --- | --- |
| `tests/profile-api.test.ts` | Customer read with `no-store`; staff refused; partial preference update; unknown IANA zone and empty update rejected. |
| `tests/profile-service.test.ts` | `investment_eligible` (device plus Google or Apple; a legacy passkey does not count); assembly of the aggregate with the display profile; stable not-found. |
| `tests/identity-display-profile-provider.test.ts` | The adapter: skips without a Didit reference or without `Approved`, maps the fields, degrades to `null` and reports on failure. |
| `tests/profile-wallet-activity-repository.integration.test.ts` | `PrismaProfileRepository` and `PrismaAccountPreferencesRepository` against a database (skipped without `TEST_DATABASE_URL`, see [../testing.md](../testing.md)). |
| `tests/wallet-claim-expiry.integration.test.ts` | The profile's wallet status after a claim expires. |
| `tests/investor-profile-doc-structure.test.ts` | The heading outline of `docs/investor-profile.md`. |

## 10. Where to put a change

| Change | Place |
| --- | --- |
| A new field on the profile that another module owns | A reader method on that module's repository port (the pattern of `KycEligibilityReader`), a new constructor argument of `PrismaProfileRepository` (`src/server.ts:571-577`), a field on `ProfileRecord`, the schema in `src/modules/profile/api/profile.schemas.ts` and the mapping in `GetProfileService`. |
| A new preference | Prisma model and migration for `account.account_preferences`, `AccountPreferencesSnapshot` and `defaultAccountPreferences`, both schemas in `src/modules/profile/api/profile.schemas.ts`, `toPreferencesPayload`, and the two `select` lists in `src/modules/profile/repository/prisma-profile.repository.ts:31-39` and `src/modules/profile/repository/prisma-account-preferences.repository.ts:19-25`. |
| Change what makes a customer investment-eligible | The offering policy first (`src/modules/offering/domain/reservation-eligibility.policy.ts`), then the copy in `src/modules/profile/application/get-profile.service.ts:38-46`. |
| Anything about names | `identity` (`GetKycDisplayProfileService`) and `src/infrastructure/cache/protected-profile-cache.ts`, not this module. |

## 11. Known limitations

| Limitation | Evidence | Issue |
| --- | --- | --- |
| The existing guide says the response does not include notification preferences and that `investment_eligible` requires "both Google and email/password recovery paths". The code returns `preferences` and `pending_closure_request` and requires a `device_key` method plus Google or Apple. The guide and the README route table do not list `PATCH /v1/investor-profile/preferences`. | `docs/investor-profile.md:14`, `docs/investor-profile.md:40`; `src/modules/profile/api/profile.schemas.ts:101-107`; `src/modules/profile/application/get-profile.service.ts:38-46` | none |
| The investing rule is duplicated between `GetProfileService` and the offering policy; nothing ties the two together except a comment. | `src/modules/profile/application/get-profile.service.ts:38-46`, `src/modules/offering/domain/reservation-eligibility.policy.ts:33-63` | none |
| Preference changes are not audited, and the route has no fresh-authentication requirement. | `src/modules/profile/api/profile.router.ts:24-36` | none |
| The module imports four other modules' `repository` types. The architecture check ignores type-only imports, so it does not report them. | `src/modules/profile/repository/prisma-profile.repository.ts:2-5`, `dependency-cruiser.config.cjs:1-35` | #122 (closed by #202; the work is listed as not done) |
| `readiness.payment_account_ready` and `wallet.status` count a pending wallet claim, while the offering detail reports `payment_account_ready` and `payout_account_verified` from a confirmed registration only, so the two answers differ until the registration is confirmed. The record names this as known and left as is (AD-279, C-011). | `src/modules/profile/application/get-profile.service.ts:89-105`, `src/modules/wallet/repository/prisma-wallet.repository.ts:278-283`, `src/modules/offering/repository/prisma-offering.repository.ts:560-562`, `src/modules/offering/application/get-investor-offering.service.ts:130-131` | none |
| `PATCH` response and `GET` response are checked with `schema.parse`; a response that fails the schema surfaces as `422 validation.invalid_field` with internal field paths and is not logged. | `src/modules/profile/api/profile.router.ts:22`, `src/modules/profile/api/profile.router.ts:35`, `src/shared/http/error-handler.ts:51-64`, `:39-41` | none (see pending #244) |

## 12. Known gaps between the code and the design record

Not compared with the record: the design record's profile and preferences definitions were not compared with the response, so this chapter claims no gap and excludes none.

## 13. Not verified

- The behaviour of the display-name cache against a real Redis or Valkey instance and a real Didit; only the in-process adapter and its tests were read.
- The staging value of `PROFILE_CACHE_URL` (`.env.staging` is not in the repository).
- Behaviour on PostgreSQL 18; local checks ran on 16.15.
