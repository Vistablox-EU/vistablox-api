# Didit individual KYC

This slice implements the baseline B2C workflow described in the backend design record. Didit remains authoritative for verification evidence; a browser redirect never changes VistaBlox eligibility.

## Runtime flow

1. An authenticated customer calls `POST /v1/kyc/sessions` with ISO 3166-1 alpha-2 residence and tax-residence declarations.
2. VistaBlox reserves a local session start, then creates a Didit v3 hosted session. The VistaBlox `account_id` is opaque `vendor_data`; a unique local start ID is provider metadata.
3. Didit sends `status.updated` or `data.updated` to `POST /webhooks/didit`.
4. VistaBlox verifies `X-Signature-V2` and the five-minute timestamp window, then durably enqueues the verified body and acknowledges immediately (`AD-062`/`ASYNC_JOBS.md`'s Webhook Handling Rule: "workers, not synchronous HTTP request handlers, own the heavy business processing") — the handler itself never calls Didit or touches eligibility state.
5. The `provider_events.didit_webhook` worker job (`src/worker.ts`) consumes that event: it correlates application/environment/workflow/session/account, deduplicates `event_id`, and — for decision-bearing statuses — fetches the current decision from Didit before applying local policy. It does not trust redirect parameters or a webhook status alone. A retried or duplicate-delivered job is a safe no-op, the same `event_id` deduplication already covered a synchronous redelivery before this change.

Owner proof of address uses the same authenticated webhook-then-fetch pattern but a separate Didit Address Verification workflow. `POST /v1/kyc/proof-of-address/sessions` is available only when baseline KYC is eligible and no current address evidence already exists. The document is captured and retained by Didit, not uploaded through VistaBlox.

## Stuck-session reconciliation

A session start can get permanently wedged with no self-service recovery path, since `canStartSession`/`canStartProofOfAddress` (`prisma-kyc.repository.ts`) both exclude `kyc_session_creating`/`kyc_session_open` (and the proof-of-address equivalents) from their retry allow-list. Two hourly `maintenance` jobs close this:

- `maintenance.kyc_stuck_session_expiry` (`ExpireStuckSessionCreationsService`, unconditionally registered): a row stuck at `kyc_session_creating`/`creating` past 15 minutes is failed outright (`failSessionStart`/`failProofOfAddressSessionStart`) — nothing user-facing happens in that window normally (`reserveSessionStart` and `completeSessionStart`/`failSessionStart` run back to back within one request), so anything longer is a crash, never a legitimately slow one, and no live Didit reference is ever recorded at this stage to reconcile against anyway.
- `maintenance.kyc_stuck_session_reconciliation` (`ReconcileStuckOpenSessionsService`, registered only when Didit is configured): a row stuck at `kyc_session_open`/`in_progress` past an hour — generous headroom past how long a baseline verification flow normally takes, not a "give up" cutoff — is re-queried against Didit's own decision endpoint. A session Didit still reports as genuinely pending is left alone and re-checked next run; one Didit now reports as anything else (most notably `Expired`/`Abandoned`, when its own webhook for that transition was lost or never sent) is applied through the exact same `evaluateDiditOutcome`/`evaluateProofOfAddressOutcome` + `applyProviderOutcome`/`applyProofOfAddressOutcome` pipeline the webhook path itself uses, tagged `webhookType: "reconciliation_poll"` in the audit trail rather than a real webhook type. No new policy is introduced — this only makes sure VistaBlox eventually learns what Didit already knows, even when webhook delivery failed.

Deliberately not built: alerting. `AD-089`'s alert-source list scopes `pg-boss` observability hooks (dead-letter count, stuck job age) to the `money_ops`/`settlement` queues specifically; neither of these jobs' `maintenance` queue is in that scope, so a stuck session that this reconciliation still can't resolve (Didit itself never transitions it) is currently only visible via this worker's own structured logs, not paged to anyone.

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

- **Alerting** on a stuck session reconciliation still can't resolve — see the Stuck-session reconciliation section above. `AD-089`'s alert scoping would need to be extended to cover these `maintenance` queues, or a bespoke mechanism built, since neither is in scope today.
- **Declared-versus-verified identity cross-validation: researched, deliberately not built, and not simply "not ready yet."** `KYC_WORKFLOW.md`'s Enhanced Review Triggers name "mismatch between document data and declared residence or tax residence" as a manual-review trigger, but the two natural ways to mechanically build that turn out to be unsound, not merely unfinished:
  - **Against the ID-verification document:** Didit's own live API documentation (`docs.didit.me`) confirms `id_verifications` exposes `nationality` and `issuing_state` (ISO 3166-1 alpha-3) — both citizenship/document-issuance concepts, not residence. A French citizen living in Germany has a French-issued passport and French nationality while legitimately declaring German residence — an entirely normal situation for the cross-border EU/EEA investor base this platform targets. Comparing `nationality`/`issuing_state` against declared residence would flag exactly that normal case, not just as a rare edge case but systematically, for a meaningful share of legitimate customers. (`id_verifications` may also expose a `parsed_address` on some document types, which would be the semantically correct field for a residence comparison — but coverage isn't uniform across the 14,000+ supported document types, e.g. passports typically don't print a home address, so this would need its own scoped look at reliability before it's buildable.)
  - **Against tax residence, by extending the existing proof-of-address check:** `evaluateApprovedProofOfAddress` (`proof-of-address-policy.ts`) already compares the PoA document's country against declared residence — extending it to also validate declared tax residence looks safe at first (same evidence, same non-blocking manual-review outcome the residence check already uses) but isn't: a single proof-of-address document can only attest to one country, and `startKycSessionBodySchema` lets a customer declare a different tax-residence country than residence with no validation requiring them to match. Any customer who legitimately did that would fail such a check every time, regardless of their proof-of-address's legitimacy — the same systematic-mismatch problem as the ID-document case, not an occasional false positive.
  
  Both would need either an explicit false-positive-tolerance policy decision (fuzzy matching? which mismatches are even worth flagging, given how normal cross-border residence/nationality/tax-residence divergence is for this customer base?) or new evidence this system doesn't collect (e.g. a tax-residency self-certification, which is out of scope for a Didit identity check specifically) before either is soundly buildable. Building either as originally conceived would create real, systematic unfairness toward legitimate customers, not just close a gap.
