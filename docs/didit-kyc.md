# Didit individual KYC

This slice implements the baseline B2C workflow described in the backend design record. Didit remains authoritative for verification evidence; a browser redirect never changes VistaBlox eligibility.

## Runtime flow

1. An authenticated customer calls `POST /v1/kyc/sessions` with ISO 3166-1 alpha-2 residence and tax-residence declarations.
2. VistaBlox reserves a local session start, then creates a Didit v3 hosted session. The VistaBlox `account_id` is opaque `vendor_data`; a unique local start ID is provider metadata.
3. Didit sends `status.updated` or `data.updated` to `POST /webhooks/didit`.
4. VistaBlox verifies `X-Signature-V2` and the five-minute timestamp window, then durably enqueues the verified body and acknowledges immediately (`AD-062`/`ASYNC_JOBS.md`'s Webhook Handling Rule: "workers, not synchronous HTTP request handlers, own the heavy business processing") — the handler itself never calls Didit or touches eligibility state.
5. The `provider_events.didit_webhook` worker job (`src/worker.ts`) consumes that event: it correlates application/environment/workflow/session/account, deduplicates `event_id`, and — for decision-bearing statuses — fetches the current decision from Didit before applying local policy. It does not trust redirect parameters or a webhook status alone. A retried or duplicate-delivered job is a safe no-op, the same `event_id` deduplication already covered a synchronous redelivery before this change.

Owner proof of address uses the same authenticated webhook-then-fetch pattern but a separate Didit Address Verification workflow. `POST /v1/kyc/proof-of-address/sessions` is available only when baseline KYC is eligible and no current address evidence already exists. The document is captured and retained by Didit, not uploaded through VistaBlox.

## Configuration

Configure all of these values together or leave all of them empty to disable the integration:

- `DIDIT_API_KEY`
- `DIDIT_WORKFLOW_ID`
- `DIDIT_CALLBACK_URL`
- `DIDIT_WEBHOOK_SECRET`
- `DIDIT_APPLICATION_ID`
- `DIDIT_ENVIRONMENT` (`sandbox` or `live`)

`DIDIT_API_BASE_URL` defaults to `https://verification.didit.me`.

`DIDIT_POA_WORKFLOW_ID` is optional and enables the separate owner proof-of-address route. That workflow must contain a Proof of Address feature and enforce the supported document types and three-month maximum document age.

The baseline Didit workflow must include government-ID verification, liveness, face match, and AML screening. The local policy additionally requires age 18 or older and both declared residence countries to be in the documented EU/EEA allowlist. A successful baseline decision uses `kyc_verified_owner_poa_missing` until the separate proof-of-address workflow is complete, and renews after 24 months for a low-risk account or 12 months for one that has ever resolved to `kyc_manual_review` (`ever_required_manual_review`, latched permanently the first time that happens, per `KYC_WORKFLOW.md`'s Renewal Policy). Approved proof-of-address evidence must match the declared residence country and remains current only until three calendar months after its document issue date.

## Data boundary

Persistent storage is deliberately limited to the provider session reference, exact provider status, local eligibility/substatus and reason, declared country codes, relevant timestamps, and eligibility dates. Full Didit responses, document numbers or images, facial/biometric data, addresses, dates of birth, session tokens, and raw webhook payloads are neither persisted nor logged.

The Didit adapter temporarily projects the fetched response in memory to the minimum policy inputs: feature statuses, AML hit count and warning risk labels, date of birth for the age calculation, and POA issue date plus country code for residence/freshness checks. Those values are discarded after the eligibility outcome is computed. For an approved individual identity only, the adapter can also project given name, family name, and full display name into the separate protected profile cache described in [`investor-profile.md`](investor-profile.md); those fields are never written to PostgreSQL.

## Operations review

`GET /internal/v1/kyc-accounts/:account_id` gives an authorized operations reviewer (`admin_operations` role, verified staff WebAuthn — the same gate as founder origination review) a read of one account's full operational eligibility record: `eligibility_state` and the more granular `operational_substatus`, the Didit provider reference, declared residence/tax-residence countries, and the equivalent proof-of-address fields. This is the same already-persisted, already privacy-minimized record the customer's own `GET /v1/kyc` reads from — never raw Didit artifacts (documents, biometrics, full provider payloads), which the data boundary above never persists in the first place. An `account_id` with no KYC record at all reports `404` rather than a synthesized "not started" response, since an arbitrary staff-supplied ID might just be a typo.

## Follow-on work

- declared-versus-verified identity cross-validation and manual-review tooling
- reconciliation/alerting for a session start stuck in `kyc_session_creating` or `kyc_session_open` (or the proof-of-address equivalents) past a reasonable time. Durable asynchronous webhook processing itself is now built (`provider_events.didit_webhook`, `src/worker.ts` — see Runtime flow above), and one concrete way a session used to get stuck this way is now fixed too: `StartKycSessionService` used to leave the row at `kyc_session_creating` forever if `completeSessionStart`'s own persistence failed after a live Didit session was already created, since nothing called `failSessionStart` to unblock a retry; it now does. What's still missing is a scheduled sweep for the harder cases nothing calls `failSessionStart` for today — a crash between reserving the session start and completing or failing it, or a Didit webhook that simply never arrives after a session opened (the only mechanism that ever advances `kyc_session_open` is that webhook; nothing polls Didit for it the way `case_timers.reservation_onramp_poll` polls Coinbase)
