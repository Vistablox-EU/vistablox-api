# Authenticated investor offering detail

`GET /v1/offerings/:offering_id` is the authenticated investor tier required by `AD-249`. It requires a valid customer session, does not require completed KYC merely to view disclosures, returns `Cache-Control: no-store`, and rejects staff/partner identities.

The response contains:

- offering terms and rights-window timestamps;
- reserved capacity, funded capital, and remaining capacity as separate values;
- PIV/issuer and residential-property detail;
- the single current, non-superseded disclosure pack and its core/supporting documents;
- the material-change log;
- the three separate account readiness states; and
- a provider-neutral reservation preflight with stable blocker codes.

`reserved_capacity_eur` sums reservations that have not been cancelled or lapsed. `funded_eur` sums only the latest money event for each reservation when that event is `eurc_reserved`, `reconfirmation_pending`, or `eurc_finalized`. A cancelled reservation therefore contributes to neither capacity nor funded progress, even if an older provider event exists.

The detail response never exposes the canonical `document_ref`. Each document instead carries an API-relative `download_path`; the authenticated download endpoint authorizes the document again and streams it from private MinIO storage. No MinIO URL or presigned URL reaches the client.

Current-pack documents are accessible to any authenticated customer, matching `AD-249`'s login-only disclosure gate. A superseded pack document is accessible only when the authenticated account has a reservation for that offering whose `disclosure_pack_version_at_reservation` matches the document's pack version. Unknown, cross-offering, and out-of-scope document IDs all return the same `404` contract.

The download response uses `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and `Cache-Control: private, no-store`. Object-store failures are mapped to provider-neutral `503` errors before streaming starts. See [`document-storage.md`](document-storage.md) for the runtime and deployment implementation.

## Reservation creation

`POST /v1/offerings/:offering_id/reservations` creates a capacity-holding reservation and an investor-initiated Coinbase CDP onramp session in one request (`AD-255`, `AD-146`). Request body: `{ "amount_eur": "1000.00" }`. On success (`201`):

```json
{
  "data": {
    "reservation_id": "reservation_...",
    "offering_id": "offering_...",
    "amount_eur": "1000.00",
    "status": "initiated",
    "expires_at": "2026-09-02T10:15:00.000Z",
    "onramp": { "url": "https://pay.coinbase.com/buy/select-asset?...", "channel_id": "..." }
  }
}
```

The reservation row and its first `money.money_events` row (`capital_state: "initiated"`) are written inside one transaction that also re-verifies, under a row lock on the `offerings` row, that the offering is still `pre_offering` and that the requested amount still fits the offering's remaining capacity (`AD-146`: the same check `GetInvestorOfferingService`'s `reservation.blockers` reports is advisory only — this is the atomic, authoritative one, sharing its rule set via `domain/reservation-eligibility.policy.ts` so the two can never disagree). A losing concurrent request gets `409 offering.reservation_not_available` (offering closed between read and write) or `422 offering.reservation_amount_exceeds_capacity` (amount no longer fits), never a silent oversell.

After the reservation is durably created, the CDP onramp session token call happens synchronously in the request path, the same way `StartKycSessionService` calls Didit — not through a job (`AD-145` governs cross-domain *state transitions*, not a single external call whose whole purpose is "start now, hand the client a URL"). If that call fails, a `purchase_failed` money event is recorded and the error propagates; the reservation row is deliberately left in place rather than unwound, because the already-decided capacity policy (reserve immediately, auto-expire if unfunded) already covers this case identically to an investor who simply never completes the purchase.

## Unfunded reservation expiry

A `case_timers.reservation_unfunded_expiry` job (`ExpireUnfundedReservationsService`, run every minute by the worker process — the other `case_timers`/`maintenance` jobs run hourly, but a 15-minute promise needs a tighter sweep) lists every `initiated` reservation and flips any older than 15 minutes to `lapsed`, exactly like `ExpireOverdueInformationRequestsService` already does for overdue information requests. There is no separate "release capacity" step: `reserved_capacity_eur` is computed by summing reservations excluding `cancelled`/`lapsed` at read/check time, so flipping the stage is the entire release. Each expiry is idempotent (a reservation no longer `initiated` by the time the job reaches it is a no-op, not an error) and writes an `offering.reservation_lapsed` audit log entry with `actor_account_id: null`, since nothing but the timer itself acts here.

`reservation_stage` and `capital_state` are separate state machines (`AD-253`): a reservation whose latest `capital_state` already shows funded (`eurc_reserved`, `reconfirmation_pending`, or `eurc_finalized`) is never auto-expired just because `reservation_stage` is still `initiated` — that combination is normal, not a bug, since `reservation_stage` only moves forward at the later finalization step described below. `listInitiatedReservationsForTimers` reports each reservation's latest `capital_state` precisely so the sweep can apply this exclusion (`isReservationFunded`, `domain/reservation-eligibility.policy.ts`).

## Advancing capital_state: the onramp transaction poll

Coinbase's onramp/offramp API has no webhook (confirmed against CDP's own API reference, not assumed — see [`docs/coinbase-cdp-onramp.md`](coinbase-cdp-onramp.md)), so a `case_timers.reservation_onramp_poll` job (`PollOnrampTransactionsService`, also every minute) is the only way `capital_state` ever moves past `eurc_purchase_pending`. It lists reservations whose latest money event is `eurc_purchase_pending`, calls `GET /onramp/v1/buy/user/{partnerUserRef}/transactions` for each (`partnerUserRef` is the reservation ID, set at session-token creation), and records a new money event: `eurc_reserved` if any returned transaction succeeded, `purchase_failed` only once nothing is still `created`/`in_progress` and at least one failed, or no change at all while everything is still in flight or nothing has started yet. This job is only registered when Coinbase credentials are configured — the one worker job so far whose sole dependency is genuinely optional, unlike the always-on `case_timers`/`maintenance` jobs.

An investor whose purchase succeeds after their reservation has already lapsed (the poll hasn't yet caught up when the 15-minute sweep runs) is a real, unresolved race this pass does not reconcile — deciding what happens to that late `EURC` is a policy question in the same territory as `AD-251`'s no-refund stance, not an implementation detail to invent here.

## The funding rail still stays closed by default

Both `GetInvestorOfferingService` and `CreateReservationService` take a `fundingRailAvailable` flag, computed once in `server.ts` as `RESERVATION_FUNDING_RAIL_ENABLED && <a configured Coinbase client>` and passed to both, so the read side and the write side can never disagree about whether reservations are open. `RESERVATION_FUNDING_RAIL_ENABLED` defaults to `false`; setting it without also configuring `COINBASE_CDP_*`/`COINBASE_ONRAMP_REDIRECT_URL` has no effect, and vice versa — either alone leaves `POST .../reservations` returning `409 funding_rail_unavailable`, deliberately, rather than a confusing half-enabled state.

This codebase cannot verify Coinbase's live EUR/Base support on its own — that is exactly the category of assumption that broke the prior Stripe-based design (see the historical evidence preserved in [`STRIPE_INTEGRATION.md`](https://github.com/Vistablox-EU/vistablox-design-docs/blob/main/Backend/04-Payments-Financial/STRIPE_INTEGRATION.md)). Before setting `RESERVATION_FUNDING_RAIL_ENABLED=true` in any environment, a human with real Coinbase CDP credentials should confirm, against the live API (not documentation):

1. `GET /onramp/v1/buy/options?country=<the investor's country>` lists `EUR` among `payment_currencies` and lists a `EURC`-on-`Base` combination among `purchase_currencies`/`networks`;
2. a real `POST /onramp/v1/token` + hosted-purchase-page round trip actually completes for a small test amount, end to end, on the configured `COINBASE_ONRAMP_BLOCKCHAIN`; and
3. the configured `COINBASE_CDP_API_KEY_ID`/`COINBASE_CDP_API_KEY_SECRET` are the intended environment's own credentials (sandbox for anything but production), since nothing in this codebase enforces that separation.

This is a one-time, per-environment gate, not a runtime check — no code here polls Coinbase's own capability endpoint before serving a reservation request, since that would add latency and a new failure mode to every request for a fact that changes rarely, if ever, once confirmed.

See [`AD-255`](https://github.com/Vistablox-EU/vistablox-design-docs/blob/main/Backend/15-Decisions-and-Rationale/ARCHITECTURE_DECISIONS.md) for the full provider decision and its "Still Open" list, and `docs/coinbase-cdp-onramp.md` for the client's exact REST surface.

## Offering finalization is a three-stage flow, not one action

`PAYMENT_FLOWS.md`'s "Phase-1 Final Offering Settlement Flow" and `AD-214`'s mandatory 168-hour reconfirmation window mean "finalizing" an offering is never a single atomic step: the founder's own decision only **publishes** locked final terms and opens a window; each investor must separately and explicitly **reconfirm** during that window; only once the window closes does a scheduled batch **commit** — and only reconfirmed reservations become positions. `offerings.status` stays `pre_offering` for the entire publish-and-reconfirm period; it becomes `final_offering` only at the very end, when the commit batch runs. The three stages below are documented in the order they occur.

### 1. Publishing final terms (founder-triggered)

`POST /internal/v1/offerings/:offering_id/finalize` is the founder's "proceed" decision from `AD-244`/`AD-245`: once an offering has fully collected `target_raise_eur` (`ipo_value_eur`), the founder chooses to proceed to tokenization, extend the `ipo_period`, or close the case — this endpoint implements only "proceed." Gated identically to origination's founder-decision endpoints: `admin_operations` role plus verified staff WebAuthn. Request body: `{ "founder_review_notes": "..." }` (required, matching `RecordFounderDecisionService`'s/`CloseCaseService`'s own convention). Response (`200`):

```json
{
  "data": {
    "offering_id": "offering_...",
    "final_offering_published_at": "2026-09-02T12:00:00.000Z",
    "effective_rights_end_at": "2026-09-09T12:00:00.000Z",
    "reservations_awaiting_reconfirmation": 3,
    "reservations_cancelled": 1
  }
}
```

Everything eligibility-relevant is re-verified atomically inside one transaction, under a row lock on the `offerings` row, mirroring `createReservation`'s own `AD-146` discipline rather than trusting an advisory read: `target_raise_eur` must still be fully funded (`AD-245` — no partial-funding path, so this is a hard `>=` gate, not the founder's discretion), the offering must still be `pre_offering`, and final terms must not already be published. A losing request gets `409 offering.finalization_target_not_reached`, `409 offering.finalization_not_available` (not open, or already published), or `404 offering.not_found` for an unknown `offering_id`.

For every reservation still `reservation_stage: "initiated"` on the offering, the same transaction locks the reservation row (`FOR UPDATE OF reservation`, alongside the offering lock) and either:

- **funded** (latest `capital_state` is `eurc_reserved`, `reconfirmation_pending`, or `eurc_finalized`) → moves the reservation to `reservation_stage: "awaiting_reconfirmation"` and records a `reconfirmation_pending` money event; or
- **not funded** (reserved but never completed payment — possible even though the *offering's total* is fully funded, if some investors reserved but others' purchases covered the shortfall) → moves the reservation to `reservation_stage: "cancelled"`.

No position is created here. The transaction also sets `final_offering_published_at`, `platform_rights_end_at`, and `effective_rights_end_at` on the offering (168 hours after publication — `computeEffectiveRightsEndAt`, `domain/finalization.policy.ts`; `PAYMENT_FLOWS.md`'s "Effective Investor-Rights Window Override" defines `effective_rights_end_at` as the max of every applicable investor-rights window, but no broader statutory/supplement-based rights table is documented anywhere yet to compute that max over, so this codebase uses the 168-hour platform default directly). `offerings.status` is deliberately left untouched — it stays `pre_offering`.

### 2. Investor reconfirmation (investor-triggered, during the open window)

`POST /v1/offerings/:offering_id/reservations/:reservation_id/reconfirm` is each investor's own explicit action, customer-only (same auth as the rest of `offering.router.ts`). Response (`200`):

```json
{
  "data": {
    "reservation_id": "reservation_...",
    "status": "reconfirmed",
    "reconfirmed_at": "2026-09-03T12:00:00.000Z"
  }
}
```

Atomically, under a row lock on the reservation: ownership is checked (`account_id` must match the caller), the reservation must be `reservation_stage: "awaiting_reconfirmation"`, and the offering's `effective_rights_end_at` must not have passed yet. A nonexistent reservation and one owned by someone else both report the same `404 offering.reservation_not_found` — deliberately, so a reservation ID never leaks whether it exists to someone who doesn't own it. The wrong stage is `409 offering.reservation_not_awaiting_reconfirmation`; a closed window is `409 offering.reconfirmation_window_closed`. On success the reservation moves to `reservation_stage: "reconfirmed"` and an audit log entry records the disclosure-pack version current at that moment (`PAYMENT_FLOWS.md`: "Reconfirmation must reference a specific disclosure-pack version and that version must remain downloadable for audit purposes").

Reconfirming does **not** yet create a position — it only marks the reservation ready for the commit batch below. `PAYMENT_FLOWS.md`'s "Silence rule" is explicit that no action is the terminal outcome for a reservation that never reconfirms: "No reconfirmation by expiry means the reservation lapses rather than silently finalizing."

### 3. Window-close commit (scheduled batch, not a person)

Once `effective_rights_end_at` passes, the hourly `case_timers.offering_reconfirmation_window_close` job (`CommitOfferingFinalizationService`, `src/worker.ts`) is the only remaining path to a `settlement.position_ledger` row. Hourly, not per-minute like the 15-minute reservation-expiry sweep: the window is 168 hours (`AD-214`), so per-minute precision buys nothing an investor would notice. For each `pre_offering` offering with published final terms, once its window has closed, a single transaction locks the offering row, re-verifies the window is actually closed (`409`-equivalent internal conflict `window_still_open` otherwise — the scheduled check and the transaction's own re-check can disagree only under a clock/timing race, and the row lock is what's authoritative), then locks every reservation still `awaiting_reconfirmation` or `reconfirmed` on that offering and either:

- **reconfirmed** → creates one `position_ledger` row, moves the reservation to `reservation_stage: "finalized"`, and records an `eurc_finalized` money event; or
- **awaiting_reconfirmation** (never reconfirmed) → moves the reservation to `reservation_stage: "lapsed"` — the same terminal stage the 15-minute unfunded-reservation sweep uses, reused rather than inventing a second "expired" stage for the same underlying idea (silence).

A position's `unit_count` and `cost_basis_eur` are both set to the reservation's own committed `amount_eur` — a deliberate 1-unit-per-EUR convention (`costBasisToUnitCount`, `domain/finalization.policy.ts`), decided because no other pricing model is recorded anywhere in the architecture (`ARCHITECTURE_DECISIONS.md`/`CORE_TABLES.md` name total approved supply and a EUR-to-units conversion as an explicit, still-open gap under `AD-238`). This rule applies only to investor-subscribed positions from a real cash reservation; it says nothing about the original owner's retained position, which has no cash cost basis to convert and remains that same unresolved `AD-238` gap. `holder_wallet_address` is copied from the investor's `settlement.wallet_registrations` row as a convenience (`AD-241`'s own framing — "not a second source of truth"); `position_status` stays `pending_internal_settlement`, since nothing here touches the chain (`AD-234` keeps production blockchain settlement dormant) or attempts to mint or transfer a token (`AD-247`: only the PIV mints, using its own signers).

Only now does the transaction set `offerings.status = "final_offering"` — the one and only place in this codebase that ever does so.

Out of scope for all three stages above, and not built: any per-jurisdiction override of the 168-hour platform default (no such table is documented — see `AD-040`/`PAYMENT_FLOWS.md`'s "Effective Investor-Rights Window Override"). Locking reservation rows in each stage blocks a concurrent expiry sweep or a concurrent later stage from racing that same reservation, but not a concurrent onramp poll: `PollOnrampTransactionsService` inserts a new `money_events` row rather than updating the reservation row, so a row lock on `reservations` doesn't block it. A purchase that lands in `money_events` in the same instant as the publish stage reads that reservation as unfunded is the same category of residual, deliberately unresolved race already named above for the expiry sweep — narrow, rare given publishing is an infrequent, deliberate staff action, and not engineered around here for the same reason.

## Materiality classification and the change-log

`POST /internal/v1/offerings/:offering_id/materiality-records` is `AD-038`'s materiality classification — staff-gated exactly like `/finalize` (`admin_operations` role plus staff WebAuthn), since `ARCHITECTURE_DECISIONS.md`'s own AD-038 discussion confirms classification is "assessed by legal and offering ownership," performed as `admin_operations`, with no dedicated narrower role. Request body:

```json
{
  "change_description": "Independent appraisal came in 7% below the disclosed valuation basis.",
  "classification": "reviewed_material",
  "threshold_type": "valuation"
}
```

`classification` is one of `per_se_material`, `reviewed_material`, or `non_material` (`CORE_TABLES.md`'s exact `materiality_records.classification` values). `threshold_type` (`valuation | cashflow | gross_rent | closing_delay`, `PAYMENT_FLOWS.md`'s "Reviewed Material Changes With Default Thresholds" table) is rejected with `422` unless `classification` is `reviewed_material` — a per-se-material change is material by category (`PAYMENT_FLOWS.md`'s enumerated "Per Se Material Changes" list: issuer/obligor identity, legal instrument or ranking, fee/price/allocation mechanics, property or PIV identity, title/encumbrance/zoning/litigation/liquidity), not by crossing a threshold, and a non-material change has no threshold to record. This codebase does not attempt to infer which classification applies from structured inputs — that judgment call belongs to the classifying staff member, informed by `AD-038`'s materiality test (`(a)` would likely require a disclosure update, or `(b)` a reasonable retail investor could realistically decide differently) — the same way `founder_review_notes` records a founder's decision rather than computing one.

What the endpoint does mechanically, atomically, under a row lock on the offering (`AD-146` discipline): a request is only accepted while the offering is between publish and commit (`final_offering_published_at` set, `status` still `pre_offering` — the same window `reconfirmReservation` itself operates in; `404 offering.not_found` for an unknown offering, `409 offering.materiality_classification_not_available` outside that window). It always inserts a `materiality_records` row and a generic audit-log entry (`offering.materiality_classified`), whatever the classification — `AD-038`: "must still be logged" applies even to `non_material` changes. `reset_triggered` is computed from `classification`, never accepted as a separate input: `per_se_material` and `reviewed_material` are always `true`, `non_material` is always `false` (`PAYMENT_FLOWS.md`'s Material-change rule: "Any material change resets the full 168-hour window and invalidates prior reconfirmations"; `AD-046`: reviewed-material thresholds are "escalation floors, not safe harbors," so a threshold-triggering change can never be waived down to non-material). When triggered, every reservation currently `reservation_stage: "reconfirmed"` on the offering moves back to `"awaiting_reconfirmation"` (clearing `reconfirmed_at`) — a reservation still only `"awaiting_reconfirmation"` has nothing to invalidate and is left untouched — and `platform_rights_end_at`/`effective_rights_end_at` are both recomputed as a **fresh** 168 hours from the classification instant, not merely extended from the old boundary. Reusing the same `effective_rights_end_at` field the window-close job reads means a reset landing after the window's old boundary but before that hourly job has actually run correctly reopens the window rather than racing a premature commit.

Response (`201`):

```json
{
  "data": {
    "materiality_record_id": "materiality_...",
    "offering_id": "offering_...",
    "classification": "reviewed_material",
    "threshold_type": "valuation",
    "reset_triggered": true,
    "classified_at": "2026-09-05T12:00:00.000Z",
    "effective_rights_end_at": "2026-09-12T12:00:00.000Z",
    "reservations_reset": 2
  }
}
```

Every created record also appears immediately in the investor-facing `change_log` (`GET /v1/offerings/:offering_id`'s response) — that read path already existed before this endpoint did, so no separate wiring was needed on the read side.

**Known, deliberately unresolved gap:** `AD-038` also states a per-se-material change "always resets the disclosure pack." No application code anywhere in this codebase creates or republishes a `disclosure_packs` row — the `disclosure_packs`/`disclosure_documents` tables have version/`is_current`/`superseded_at` columns, but only read paths exist (`GetInvestorOfferingService`, `DownloadDisclosureDocumentService`). Disclosure-pack authoring (staff uploading new documents, versioning, superseding the prior pack) is a separate, materially larger, still-unbuilt prerequisite feature — this endpoint records the classification and applies the reconfirmation-window consequence, but does not and cannot also publish a new disclosure pack as a side effect. `materiality_records` also has no column linking a record to the disclosure-pack version it prompted, for the same reason.
