# Module: identity

Valid for main at 48aa967 (2026-11-18).

The `identity` module owns individual KYC: it starts hosted verification sessions at Didit, receives and processes Didit's webhooks, turns the provider's decision into a local eligibility state, keeps the proof-of-address state for property owners, and runs the renewal and stuck-session timers. Other modules read its eligibility record to decide who may invest, register a wallet or submit a case. Read this page before you change who counts as verified, what is stored about a verification, or how a Didit event is handled.

## 1. Purpose and bounded context

| Question | Answer |
| --- | --- |
| What does the module own? | Three customer routes under `/v1/kyc`, one staff route under `/internal/v1/kyc-accounts`, the public webhook `POST /webhooks/didit`, the queue `provider_events.didit_webhook` and three `maintenance` queues, and the tables `identity.kyc_eligibility` and `identity.kyc_eligibility_history` (`src/app.ts:908-936`, section 3). |
| What does it decide? | `eligibility_state` (`not_started`, `in_progress`, `pending_manual_review`, `eligible`, `unsupported_jurisdiction`, `not_eligible`, `requires_renewal`, `suspended_restricted`), the finer `operational_substatus`, the proof-of-address status and the renewal date, from a Didit status and decision (`src/modules/identity/domain/kyc-policy.ts:16-42`). |
| What is authoritative? | Didit holds the evidence. A redirect never changes eligibility; the webhook is a trigger, and for decision-bearing statuses the current decision is fetched from Didit before the policy runs (`src/modules/identity/application/kyc.service.ts:456-459`, [../didit-kyc.md](../didit-kyc.md)). |
| What is stored? | Provider session reference and status, local state and reason, the two declared country codes, timestamps and dates, the manual-review latch. Not stored: provider payloads, document data, biometrics, addresses, dates of birth, session tokens, display names (`prisma/schema/schema.prisma:124-148`, [../didit-kyc.md](../didit-kyc.md)). |
| What it does not own | Display-name caching (the cache lives in `src/infrastructure/cache`, the adapter in `src/infrastructure/profile`); the use of eligibility by other modules; account recovery's own Didit session (the `auth` module reuses the `DiditClient` port). |
| Who may call the routes? | Customer routes: customers only (`403 authorization.forbidden` otherwise, `src/modules/identity/api/kyc.router.ts:124-144`). Staff route: `requireAuthentication`, `requireAdminOperations`, `requireStaffWebAuthn` (`src/modules/identity/api/kyc-operations.router.ts:17`). The webhook has no session; it is authenticated by signature. |

## 2. File map

| Layer | File | Lines | Responsibility |
| --- | --- | --- | --- |
| api | `src/modules/identity/api/kyc.router.ts` | 148 | `createKycRouter` (`GET /`, `POST /sessions`, `POST /proof-of-address/sessions`) and `createDiditWebhookRouter` (`POST /`, signature check, then enqueue). |
| api | `src/modules/identity/api/kyc-operations.router.ts` | 27 | `createKycOperationsRouter`: `GET /:account_id` for staff. |
| api | `src/modules/identity/api/kyc.schemas.ts` | 150 | Zod schemas: country-code body, status and session responses, the webhook body, the staff view. |
| application | `src/modules/identity/application/kyc.service.ts` | 576 | `StartKycSessionService`, `GetKycStatusService`, `GetKycAccountForOperationsService`, `StartProofOfAddressSessionService`, `ReceiveDiditWebhookService`, `ProcessDiditWebhookService` (the worker side), `processDiditWebhookJobSchema`. |
| application | `src/modules/identity/application/kyc-renewal.service.ts` | 49 | `RunKycRenewalTimerService`: renewal reminder emails and the automatic `requires_renewal` transition. |
| application | `src/modules/identity/application/kyc-stuck-session.service.ts` | 174 | `ExpireStuckSessionCreationsService`, `ReconcileStuckOpenSessionsService` and their thresholds. |
| application | `src/modules/identity/application/kyc-display-profile.service.ts` | 132 | `GetKycDisplayProfileService`: the verified display name for an approved account, through the protected cache; without a cache it answers `null`, and a cached entry younger than six hours is served without a Didit call (`:41-52`). |
| application | `src/modules/identity/application/didit-client.ts` | 19 | The port `DiditClient` (`createSession`, `getDecision`). |
| domain | `src/modules/identity/domain/kyc-policy.ts` | 387 | `evaluateDiditOutcome`, `isRenewalReminderDue`, `isRenewalOverdue`, the status and state types. |
| domain | `src/modules/identity/domain/proof-of-address-policy.ts` | 156 | `evaluateProofOfAddressOutcome`. |
| domain | `src/modules/identity/domain/stuck-session.policy.ts` | 17 | `isSessionStuck`. |
| infrastructure | `src/modules/identity/infrastructure/didit.client.ts` | 280 | `HttpDiditClient`: Didit v3 session creation and decision fetch. |
| infrastructure | `src/modules/identity/infrastructure/didit-webhook-verifier.ts` | 72 | `DiditWebhookVerifier`: HMAC-SHA256 over the canonicalized body, five-minute window. |
| repository | `src/modules/identity/repository/kyc.repository.ts` | 149 | `KycRepository`, `KycEligibilityRecord`. |
| repository | `src/modules/identity/repository/kyc-eligibility-reader.ts` | 31 | The read port `KycEligibilityReader` and `KycEligibilitySnapshot` that other modules use. |
| repository | `src/modules/identity/repository/prisma-kyc.repository.ts` | 880 | `PrismaKycRepository` implements `KycRepository` and `KycEligibilityReader`; also enqueues the webhook job. |

Wiring: `src/server.ts:121` builds one `PrismaKycRepository(database, jobQueue)`; `src/server.ts:385-391` builds `HttpDiditClient` with a 4-second timeout; `src/server.ts:442` builds the verifier; `src/app.ts:908-936` mounts the three routers. In the worker, `src/worker.ts:103-110` and `src/worker.ts:158` build the timer and webhook services.

> Pending #237: the identity mounts move from `src/app.ts` into `src/composition/compose-identity.ts`; the routers, services and repository do not change.

## 3. Public surface

### 3.1 Routes

Entries with request and response fields are in [../api/platform.md](../api/platform.md) (sections "KYC (customer)", "KYC (staff)" and "Didit webhook").

| Method | Path | Authentication | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/v1/kyc` | session, customer | `eligibility_state`, `proof_of_address_status`, `proof_of_address_current_until`, `last_verified_at`, `renewal_due_at`, `active_session` (a freshly fetched resume URL, or `null`) (`src/modules/identity/application/kyc.service.ts:127-140`). A Didit failure while resolving `active_session` gives `null`, not an error (`:155`). |
| `POST` | `/v1/kyc/sessions` | session, customer | Body: residence and tax-residence country codes, optional language. Reserves the start, creates the Didit session, answers `201`. `409 identity.kyc_session_unavailable` when the state does not allow a new session; `502 identity.kyc_provider_response_invalid`; `503 identity.kyc_provider_unavailable` (raised by the HTTP client, `src/modules/identity/infrastructure/didit.client.ts:262-270`); `500 identity.kyc_session_persistence_failed` (`src/modules/identity/application/kyc.service.ts:24-118`, `src/modules/identity/application/kyc.service.ts:550-576`). |
| `POST` | `/v1/kyc/proof-of-address/sessions` | session, customer | Starts the owner proof-of-address session; the account must already be `eligible` (`src/modules/identity/repository/prisma-kyc.repository.ts:293-306`). `404 identity.proof_of_address_not_configured` when `DIDIT_POA_WORKFLOW_ID` is unset; `409 identity.proof_of_address_session_unavailable`; `502 identity.kyc_provider_response_invalid`; `503 identity.kyc_provider_unavailable`; `500 identity.proof_of_address_session_persistence_failed` (`src/modules/identity/api/kyc.router.ts:62-92`, `src/modules/identity/application/kyc.service.ts:240-319`, `src/modules/identity/application/kyc.service.ts:559-576`). |
| `GET` | `/internal/v1/kyc-accounts/:account_id` | staff: admin operations and WebAuthn | The full operational record of one account; `404 identity.kyc_account_not_found` for an unknown id (`src/modules/identity/application/kyc.service.ts:188-238`). |
| `POST` | `/webhooks/didit` | signature `X-Signature-V2`, timestamp `X-Timestamp` | Verifies, validates the body, enqueues `provider_events.didit_webhook` and answers `{ received: true }`; `401 identity.didit_webhook_invalid` on a bad signature or timestamp (`src/modules/identity/api/kyc.router.ts:94-122`). |

The mounts exist whenever the protected API exists; the Didit settings are required by the environment schema, so there is no disabled mode (`src/app.ts:908-936`, [../didit-kyc.md](../didit-kyc.md)). The routes use no `Idempotency-Key` middleware; `reserveSessionStart` is the guard against a second open session. The webhook route is outside the rate limiters of `requireAuthentication`.

> Pending #244: the identity routers send their body through `sendValidated`, so a body that fails its response schema becomes `500 internal.response_invalid` instead of `422 validation.invalid_field`; #245 does the same for the routers #244 does not cover.

### 3.2 Jobs and queues

| Queue | Kind | Trigger | Handler | Owner, tier |
| --- | --- | --- | --- | --- |
| `provider_events.didit_webhook` | event | the webhook route (`PrismaKycRepository.enqueueDiditWebhookProcessing`, a plain `pgBoss.send` with `JOB_RETRY_OPTIONS`, `src/modules/identity/repository/prisma-kyc.repository.ts:69-99`, `src/shared/jobs/enqueue-job.ts:21-26`) | `ProcessDiditWebhookService.execute` (`src/worker.ts:838-855`) | identity, `tier_1` |
| `maintenance.kyc_renewal` | scheduled `0 9 * * *` | schedule (`src/worker.ts:565-568`) | `RunKycRenewalTimerService.execute` (`src/worker.ts:805-807`) | identity, `tier_2` |
| `maintenance.kyc_stuck_session_expiry` | scheduled `0 * * * *` | schedule (`src/worker.ts:572-575`) | `ExpireStuckSessionCreationsService.execute` (`src/worker.ts:808-813`) | identity, `tier_2` |
| `maintenance.kyc_stuck_session_reconciliation` | scheduled `0 * * * *` | schedule (`src/worker.ts:576-579`) | `ReconcileStuckOpenSessionsService.execute` (`src/worker.ts:814-819`) | identity, `tier_2` |

The two stuck-session jobs also set the worker gauges `vistablox_worker_kyc_creating_overdue` and `vistablox_worker_kyc_open_overdue` (`src/worker.ts:810`, `src/worker.ts:816`). Retry, dead-lettering and the full table are in [../jobs-and-workers.md](../jobs-and-workers.md). The webhook job is replay-safe: a processed `event_id` is skipped through the audit key `didit:webhook:<eventId>` (`src/modules/identity/application/kyc.service.ts:390-393`).

### 3.3 Audit rows written

`identity.kyc_session_started`, `identity.kyc_session_start_failed`, `identity.proof_of_address_session_started`, `identity.proof_of_address_session_start_failed`, `identity.didit_webhook_received` (written when an event is claimed, doubling as the idempotency key), `identity.didit_webhook_unmatched` (an event that matched nothing, with a reason) and `identity.kyc_renewal_due` (the automatic `requires_renewal` transition), all from `src/modules/identity/repository/prisma-kyc.repository.ts` (lines 229, 269, 358, 398, 424, 534, 637, 709). State changes are also written to `identity.kyc_eligibility_history` (previous state, new state, reason code).

## 4. Tables

| Table | Access | Notes |
| --- | --- | --- |
| `identity.kyc_eligibility` | read, insert, update | One row per account: Didit references for the baseline and the proof-of-address sessions (each unique), provider statuses, `eligibility_state`, `operational_substatus`, `proof_of_address_status`, the declared countries, `proof_of_address_current_until`, `last_verified_at`, `ever_required_manual_review`, `renewal_due_at` (`prisma/schema/schema.prisma:124-148`). |
| `identity.kyc_eligibility_history` | insert | One row per state change (`prisma/schema/schema.prisma:151-163`). |
| `audit.audit_log` | insert, read | The actions in section 3.3 and the webhook idempotency keys. |
| `account.accounts` | read, row lock | The contact email for the renewal reminder (`src/modules/identity/repository/prisma-kyc.repository.ts:654-670`, `src/modules/identity/application/kyc-renewal.service.ts:34-44`); `reserveSessionStart` and `reserveProofOfAddressSessionStart` lock the account row with `FOR UPDATE` before they read the KYC row (`src/modules/identity/repository/prisma-kyc.repository.ts:153-158`, `:286-291`). |
| `platform.settings` | read | The key `identity.kyc_renewal_reminder_lead_days`; the read throws when the row is missing (`src/modules/identity/repository/prisma-kyc.repository.ts:101-110`, called at `src/modules/identity/application/kyc-renewal.service.ts:20`). |

Model definitions are in [../data-model.md](../data-model.md).

## 5. Domain rules and state machines

### 5.1 Baseline KYC outcome

`evaluateDiditOutcome` maps a Didit status (and, for `Approved`, the decision) to a state (`src/modules/identity/domain/kyc-policy.ts:130-293`):

| Didit status | eligibility_state | operational_substatus | reason |
| --- | --- | --- | --- |
| `Not Started` | `not_started` | `kyc_session_open` | `KYC_SESSION_OPEN` |
| `In Progress` | `in_progress` | `kyc_pending` | `KYC_SESSION_PENDING` |
| `Resubmitted` | `in_progress` | `kyc_resubmission_pending` | `KYC_RESUBMISSION_REQUIRED` |
| `In Review` | `pending_manual_review` | `kyc_manual_review` | a warning reason or `KYC_MANUAL_REVIEW` |
| `Expired`, `Abandoned` | `not_started` | `kyc_restart_required` | `KYC_SESSION_EXPIRED`, `KYC_SESSION_ABANDONED` |
| `Kyc Expired` | `requires_renewal` | `kyc_reverification_required` | `KYC_REVERIFICATION_REQUIRED` |
| `Awaiting User`, none | `pending_manual_review` | `kyc_integration_anomaly` | `PROVIDER_STATUS_ANOMALY` |
| `Declined` | `pending_manual_review` for a reason in the manual-review set, else `not_eligible` | `kyc_manual_review` or `kyc_failed` | the decision's warning reason, default `ID_DOCUMENT_INVALID` |
| `Approved` | see below | | |

For `Approved`, in this order (`:207-293`): a residence or tax-residence country that is missing or not in the 30-country allowlist (27 EU states plus IS, LI, NO) is `unsupported_jurisdiction` (`:108-112`, `:213-224`); a missing decision, or a decision that lacks an ID verification, a liveness check, a face match or an AML screening, is an integration anomaly (`:226-238`); an ID verification not approved is a failure or a manual review by its warning reason (`:240-250`); a liveness check not approved is `not_eligible` `BIOMETRIC_LIVENESS_FAIL` (`:251-253`); a face match not approved is manual review `BIOMETRIC_FACE_MISMATCH` (`:254-260`); an AML screening not approved or with any hit is manual review (`:261-271`); a missing date of birth is an anomaly and an age under 18 is `not_eligible` `AGE_UNDER_18`; a date of birth that is not a valid `YYYY-MM-DD` date counts as under 18 (`:273-282`, `:373-387`). Otherwise the account is `eligible` with substatus `kyc_verified_owner_poa_missing` and reason `KYC_BASELINE_APPROVED` (`:284-292`). The manual-review reasons are `ID_DOCUMENT_TAMPER_SUSPECTED`, `BIOMETRIC_FACE_MISMATCH`, `IDENTITY_DATA_MISMATCH`, `AML_SANCTIONS_HIT`, `AML_PEP_REVIEW`, `AML_ADVERSE_MEDIA_REVIEW` (`:114-121`).

Renewal: an eligible account gets `renewal_due_at` 24 months after the event time, or 12 months when the account has ever resolved to manual review; the event time is the webhook's `created_at` (`src/modules/identity/application/kyc.service.ts:394`, `:498`) or the run time of a reconciliation poll (`src/modules/identity/application/kyc-stuck-session.service.ts:145`). The latch `ever_required_manual_review` is only ever set, never cleared, by this code (`:123-147`, `src/modules/identity/repository/prisma-kyc.repository.ts:481`). The daily timer sends a reminder on the one calendar day `lead days` before the date and moves the account to `requires_renewal` once the date has passed (`:295-317`, `src/modules/identity/application/kyc-renewal.service.ts:16-48`).

A new session may start only from `kyc_not_started`, `kyc_session_creation_failed`, `kyc_restart_required` or `kyc_reverification_required` (`src/modules/identity/repository/prisma-kyc.repository.ts:808-815`).

### 5.2 Proof of address

`evaluateProofOfAddressOutcome` (`src/modules/identity/domain/proof-of-address-policy.ts:42-122`): `Approved` needs at least one proof-of-address verification and a declared residence country, otherwise `integration_anomaly`; every verification must be approved without warnings and carry an issue date that is not in the future and a document country (two or three letter code, normalized) equal to the declared residence, otherwise `pending_manual_review` (`:72-109`). The status is then `current` until the earliest issue date plus three calendar months (clamped to month end) and `expired` once that has passed (`:111-121`). `In Review` is `pending_manual_review`, `Declined` is `insufficient`, `Expired`, `Abandoned` and `Kyc Expired` are `restart_required`, `Awaiting User` or no status is `integration_anomaly`, and `Not Started`, `In Progress` and `Resubmitted` are `in_progress` (`:48-69`). A proof-of-address session may start only for an account whose `eligibility_state` is `eligible` and whose proof-of-address status is `not_started`, `creation_failed`, `insufficient`, `expired`, `restart_required` or `integration_anomaly`, or `current` once `proof_of_address_current_until` has passed; `creating`, `in_progress`, `pending_manual_review` and a still valid `current` refuse it (`src/modules/identity/repository/prisma-kyc.repository.ts:296-306`, `:817-834`).

### 5.3 Webhook handling

The route verifies the signature and timestamp, then only enqueues. The worker job classifies each event (`src/modules/identity/application/kyc.service.ts:388-480`); it fetches the Didit decision only for the statuses `Approved`, `Declined`, `In Review` and `Abandoned` (`src/modules/identity/application/kyc.service.ts:456-459`, `:541-548`):

| Check | Result |
| --- | --- |
| `event_id` already processed | skipped as a duplicate |
| application id, environment or workflow id does not match the configuration; a business session; a type other than `status.updated` or `data.updated` | recorded as unmatched, reason `configuration_mismatch` |
| no local session with that Didit reference | unmatched, `session_not_found` |
| `vendor_data` is not the session's account id | unmatched, `correlation_mismatch` |
| the fetched decision's session, kind (`business`), vendor data, workflow or status disagrees with the event | unmatched, `correlation_mismatch` (`:460-480`) |
| otherwise | the policy runs on the fetched decision and the outcome is applied |

Signature rule: `X-Timestamp` must be ten digits, within 300 seconds of the server clock and equal to the body's `timestamp`; `X-Signature-V2` must be 64 hex digits and equal the HMAC-SHA256 of the JSON of the body with its keys sorted at every level, compared in constant time (`src/modules/identity/infrastructure/didit-webhook-verifier.ts:11-49`).

### 5.4 Stuck sessions

A baseline row at `kyc_session_creating`, or a proof-of-address row at `creating`, that has not been updated for the creating threshold is failed (`src/modules/identity/application/kyc-stuck-session.service.ts:32-71`). A baseline row at `kyc_session_open`, or a proof-of-address row at `in_progress`, that has not been updated for the open threshold is re-queried at Didit; unless Didit still reports `Not Started`, `In Progress` or `Awaiting User`, the result goes through the same policy and write as a webhook (`src/modules/identity/application/kyc-stuck-session.service.ts:86`, `:104-173`). In the worker the two thresholds are `KYC_CREATING_ALERT_AFTER_MINUTES` (default 15 minutes) and `KYC_OPEN_ALERT_AFTER_MINUTES` (default 60 minutes), passed to the services as their timeout (`src/worker.ts:104-114`, `src/config/environment.ts:373-374`); the constants `KYC_CREATING_STUCK_TIMEOUT_MS` and `KYC_OPEN_RECONCILIATION_THRESHOLD_MS` are only the constructor defaults (`:18`, `:79`). Each run also sets a gauge and logs a warning with the number of sessions past the threshold (`src/worker.ts:808-819`).

## 6. Interaction with other modules

| Other module | Direction | How |
| --- | --- | --- |
| `intake` | intake reads | `KycEligibilityReader` type (`src/modules/intake/repository/prisma-intake.repository.ts:9`), met by the shared `PrismaKycRepository`; intake also imports the type of `GetKycDisplayProfileService` for the staff case view (`src/modules/intake/application/operations-case.service.ts:2`). |
| `offering` | offering reads | `KycEligibilityReader` type (`src/modules/offering/repository/prisma-offering.repository.ts:7`) for reservation eligibility. |
| `wallet` | wallet reads | `KycEligibilityReader` type (`src/modules/wallet/application/register-wallet.service.ts:5`). |
| `profile` | profile reads | `KycEligibilityReader` type (`src/modules/profile/repository/prisma-profile.repository.ts:3`) and the display name through `src/infrastructure/profile/identity-display-profile.provider.ts`. |
| `auth` | auth uses the port | The staff account-recovery services take the `DiditClient` type from identity's application layer (`src/modules/auth/application/staff/account-recovery.service.ts:5`); recovery reuses the baseline workflow. |
| Jobs | none enqueued across modules | The webhook job is identity's own. |

All of these are `import type` statements into another module's `repository` or `application` directory, not job calls. The architecture check ignores type-only imports (section 11).

## 7. Configuration

| Variable | Effect |
| --- | --- |
| `DIDIT_API_KEY`, `DIDIT_WORKFLOW_ID`, `DIDIT_CALLBACK_URL`, `DIDIT_WEBHOOK_SECRET`, `DIDIT_APPLICATION_ID`, `DIDIT_ENVIRONMENT` | Required at boot (`src/config/environment.ts:241-247`); `DIDIT_WEBHOOK_SECRET` is at least 16 characters. |
| `DIDIT_API_BASE_URL` | Default `https://verification.didit.me`. |
| `DIDIT_POA_WORKFLOW_ID` | Optional; must differ from `DIDIT_WORKFLOW_ID` (`src/config/environment.ts:251`, `:456-460`). Unset: the proof-of-address route answers `404`. |
| `KYC_CREATING_ALERT_AFTER_MINUTES`, `KYC_OPEN_ALERT_AFTER_MINUTES` | Ages at which the two stuck-session jobs act on a session (fail a creation, re-query an open session) and warn about it, defaults 15 and 60 minutes, integers 1 to 1440 and 1 to 10080 (`src/config/environment.ts:373-374`, `src/worker.ts:104-114`). |
| `PROFILE_CACHE_URL` | The display-name cache that a KYC state change invalidates. |

The full list is in [../configuration.md](../configuration.md). Secrets appear in the documentation only as the placeholder names used in `.env.example`.

## 8. Existing guide

[../didit-kyc.md](../didit-kyc.md) describes the flow, resuming a session, stuck-session reconciliation, configuration, the data boundary, operations review, and the researched and rejected cross-validation. Its alerting note predates the dead-letter alert (section 11).

## 9. Tests

| File | What it covers |
| --- | --- |
| `tests/kyc-policy.test.ts`, `tests/proof-of-address-policy.test.ts`, `tests/stuck-session-policy.test.ts` | The three policies. |
| `tests/kyc-service.test.ts` | The application services. |
| `tests/kyc-api.test.ts`, `tests/kyc-operations-api.test.ts` | The customer, webhook and staff routes. |
| `tests/kyc-renewal-service.test.ts`, `tests/kyc-stuck-session-service.test.ts` | The timers. |
| `tests/didit-client.test.ts`, `tests/didit-environment.test.ts`, `tests/didit-webhook-verifier.test.ts` | The HTTP client, the environment rules, the verifier. |
| `tests/kyc-display-profile-service.test.ts`, `tests/identity-display-profile-provider.test.ts` | The display-name service and the adapter. |
| `tests/kyc-repository.integration.test.ts` | `PrismaKycRepository` against a database; skipped without `TEST_DATABASE_URL` (see [../testing.md](../testing.md)). |

No test runs against a real Didit.

## 10. Where to put a change

| Change | Place |
| --- | --- |
| Who counts as verified (a new check on the decision, a new country) | `src/modules/identity/domain/kyc-policy.ts` and `tests/kyc-policy.test.ts`; the allowlist is `supportedCountries`. The proof-of-address list is a separate map in `proof-of-address-policy.ts`. |
| A new field read from Didit | The adapter `src/modules/identity/infrastructure/didit.client.ts` and `DiditDecisionSummary`; check the data boundary first: nothing personal may reach PostgreSQL. |
| A new reader of eligibility in another module | A field on `KycEligibilitySnapshot` and `SNAPSHOT_SELECT` in the repository, not a new query in the other module. |
| Renewal interval or reminder | `evaluateDiditOutcome` for the interval; the lead days are a `platform.settings` row. |
| A new webhook type | `processDiditWebhookJobSchema` and the classification in `ProcessDiditWebhookService.execute`. |
| Anything about sign-in or recovery | `auth`. |

## 11. Known limitations

| Limitation | Evidence | Issue |
| --- | --- | --- |
| The renewal reminder matches exactly one calendar day and the job runs once a day, with no "sent" marker; a day on which the worker is down sends no reminder. | `src/modules/identity/domain/kyc-policy.ts:295-313` | none |
| `GET /v1/kyc` calls Didit on every read while a session is open (4-second timeout; a failure gives `active_session: null`). | `src/modules/identity/application/kyc.service.ts:151-164`, `src/server.ts:385-389` | none |
| The webhook is verified over the re-serialised JSON of the parsed body, not the raw bytes. | `src/modules/identity/infrastructure/didit-webhook-verifier.ts:27-29`, `src/app.ts:588` | none |
| Stuck sessions that the reconciliation cannot resolve produce only a warning log; the guide's note that nothing is paged predates the dead-letter alert, which covers failed jobs, not an unresolved session. | `src/worker.ts:811`, `src/worker.ts:817`, `docs/didit-kyc.md:37` | #222 |
| Other modules import identity's `repository` and `application` types; the architecture check ignores type-only imports, so none is reported. | `src/modules/wallet/application/register-wallet.service.ts:5`, `src/modules/intake/application/operations-case.service.ts:2`, `src/modules/auth/application/staff/account-recovery.service.ts:5`, `dependency-cruiser.config.cjs:1-35` | #122 (closed by #202; the work is listed as not done) |
| A response that fails its schema surfaces as `422 validation.invalid_field` with internal field paths and is not logged. | `src/modules/identity/api/kyc.router.ts:40`, `src/shared/http/error-handler.ts:39-41`, `src/shared/http/error-handler.ts:51-64` | none (see pending #244, #245) |

## 12. Known gaps between the code and the design record

| Statement in the record | Code | Register |
| --- | --- | --- |
| `KYC_WORKFLOW.md`'s state diagram shows a renewal session moving to `InProgress`, while its Didit-to-internal mapping table maps Didit `Not Started` to `Not started`. | The code follows the mapping table: when a renewal session opens, the exposed state becomes `not_started`, so a customer stops seeing `requires_renewal` while re-verifying. | C-005 |
| The Didit cross-validation of declared and verified identity data (an enhanced-review trigger in the record). | Not built; the guide records why (nationality is not residence; one proof of address attests one country). | none; [../didit-kyc.md](../didit-kyc.md) |

Register entries are in `00-Governance/MIGRATION/CONFLICT_REGISTER.md` on the `origin/main` of the design-record repository. The record was not edited.

## 13. Not verified

- Behaviour against a real Didit (v3 session, decision and webhook formats); only the client code and its tests were read, and the webhook JSON key names are as the code assumes them.
- Whether the signature rule over the re-serialised body matches Didit's signing for every payload shape.
- The staging and production values of the `DIDIT_*` variables and the Didit workflow contents (they live outside the repository).
- Behaviour on PostgreSQL 18; local checks ran on 16.15.
