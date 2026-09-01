# Didit individual KYC

This slice implements the baseline B2C workflow described in the backend design record. Didit remains authoritative for verification evidence; a browser redirect never changes VistaBlox eligibility.

## Runtime flow

1. An authenticated customer calls `POST /v1/kyc/sessions` with ISO 3166-1 alpha-2 residence and tax-residence declarations.
2. VistaBlox reserves a local session start, then creates a Didit v3 hosted session. The VistaBlox `account_id` is opaque `vendor_data`; a unique local start ID is provider metadata.
3. Didit sends `status.updated` or `data.updated` to `POST /webhooks/didit`.
4. VistaBlox verifies `X-Signature-V2`, enforces the five-minute timestamp window, correlates application/environment/workflow/session/account, and deduplicates `event_id`.
5. For decision-bearing statuses, VistaBlox fetches the current decision from Didit before applying local policy. It does not trust redirect parameters or a webhook status alone.

## Configuration

Configure all of these values together or leave all of them empty to disable the integration:

- `DIDIT_API_KEY`
- `DIDIT_WORKFLOW_ID`
- `DIDIT_CALLBACK_URL`
- `DIDIT_WEBHOOK_SECRET`
- `DIDIT_APPLICATION_ID`
- `DIDIT_ENVIRONMENT` (`sandbox` or `live`)

`DIDIT_API_BASE_URL` defaults to `https://verification.didit.me`.

The Didit workflow must include government-ID verification, liveness, face match, and AML screening. The local policy additionally requires age 18 or older and both declared residence countries to be in the documented EU/EEA allowlist. A successful baseline decision renews after 24 months and uses `kyc_verified_owner_poa_missing` until the separate proof-of-address workflow is complete.

## Data boundary

Persistent storage is deliberately limited to the provider session reference, exact provider status, local eligibility/substatus and reason, declared country codes, relevant timestamps, and eligibility dates. Full Didit responses, document numbers or images, facial/biometric data, addresses, dates of birth, session tokens, and raw webhook payloads are neither persisted nor logged.

The Didit adapter temporarily projects the fetched response in memory to the minimum policy inputs: feature statuses, AML hit count and warning risk labels, and date of birth for the age calculation. Those values are discarded after the eligibility outcome is computed.

## Follow-on work

- proof-of-address ingestion and freshness rules for owner intake
- protected short-lived decision display for authorized operations reviewers
- declared-versus-verified identity cross-validation and manual-review tooling
- durable asynchronous webhook processing with reconciliation/alerting for stuck session starts
- higher-risk renewal intervals and scheduled expiry/reminder workers
