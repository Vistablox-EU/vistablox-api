# Didit individual KYC

This slice implements the baseline B2C workflow described in the backend design record. Didit remains authoritative for verification evidence; a browser redirect never changes VistaBlox eligibility.

## Runtime flow

1. An authenticated customer calls `POST /v1/kyc/sessions` with ISO 3166-1 alpha-2 residence and tax-residence declarations.
2. VistaBlox reserves a local session start, then creates a Didit v3 hosted session. The VistaBlox `account_id` is opaque `vendor_data`; a unique local start ID is provider metadata.
3. Didit sends `status.updated` or `data.updated` to `POST /webhooks/didit`.
4. VistaBlox verifies `X-Signature-V2`, enforces the five-minute timestamp window, correlates application/environment/workflow/session/account, and deduplicates `event_id`.
5. For decision-bearing statuses, VistaBlox fetches the current decision from Didit before applying local policy. It does not trust redirect parameters or a webhook status alone.

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

The baseline Didit workflow must include government-ID verification, liveness, face match, and AML screening. The local policy additionally requires age 18 or older and both declared residence countries to be in the documented EU/EEA allowlist. A successful baseline decision renews after 24 months and uses `kyc_verified_owner_poa_missing` until the separate proof-of-address workflow is complete. Approved proof-of-address evidence must match the declared residence country and remains current only until three calendar months after its document issue date.

## Data boundary

Persistent storage is deliberately limited to the provider session reference, exact provider status, local eligibility/substatus and reason, declared country codes, relevant timestamps, and eligibility dates. Full Didit responses, document numbers or images, facial/biometric data, addresses, dates of birth, session tokens, and raw webhook payloads are neither persisted nor logged.

The Didit adapter temporarily projects the fetched response in memory to the minimum policy inputs: feature statuses, AML hit count and warning risk labels, date of birth for the age calculation, and POA issue date plus country code for residence/freshness checks. Those values are discarded after the eligibility outcome is computed. For an approved individual identity only, the adapter can also project given name, family name, and full display name into the separate protected profile cache described in [`investor-profile.md`](investor-profile.md); those fields are never written to PostgreSQL.

## Operations review

`GET /internal/v1/kyc-accounts/:account_id` gives an authorized operations reviewer (`admin_operations` role, verified staff WebAuthn — the same gate as founder origination review) a read of one account's full operational eligibility record: `eligibility_state` and the more granular `operational_substatus`, the Didit provider reference, declared residence/tax-residence countries, and the equivalent proof-of-address fields. This is the same already-persisted, already privacy-minimized record the customer's own `GET /v1/kyc` reads from — never raw Didit artifacts (documents, biometrics, full provider payloads), which the data boundary above never persists in the first place. An `account_id` with no KYC record at all reports `404` rather than a synthesized "not started" response, since an arbitrary staff-supplied ID might just be a typo.

## Follow-on work

- declared-versus-verified identity cross-validation and manual-review tooling
- durable asynchronous webhook processing with reconciliation/alerting for stuck session starts
- higher-risk renewal intervals and scheduled expiry/reminder workers
