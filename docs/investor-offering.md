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

## Opening an offering while token settlement is dormant

`case_timers.pre_offering_open_handoff` (`OpenOfferingForApprovedCaseService`, run by the worker) creates the `Piv` and `Offering` for an approved case. When the worker also runs the on-chain settlement bundle (`AD-256`), the same transaction enqueues `settlement.open_ipo_escrow_campaign`. `AD-234` launches production with token settlement dormant, so the bundle is unconfigured there: the worker neither creates nor consumes that queue, and the open does not enqueue the job (`openEscrowCampaign: false`, derived in `src/worker.ts` from the same condition that registers the queue and its consumer). Enqueueing anyway would fail the whole open with pg-boss's `Queue ... does not exist` and roll back the `Piv`/`Offering`, so no approved case could become a listing.

The job is not enqueued "just in case" for two reasons. A job left waiting carries the target amount and deadline frozen at enqueue time, which can be stale by the time a consumer exists (the escrow contract rejects a deadline that has passed), and pg-boss deletes a job that is still unconsumed when its retention runs out (14 days from enqueue by default), so campaigns would be lost without any signal. Offerings opened while dormant therefore have no campaign job. For an offering whose `ipo_end_at` passes while settlement is dormant, a campaign can never be opened. For one whose window is still running at activation, an operator opens it with the command described in the section below (`npm run settlement:open-ipo-escrow-campaigns`); `OpenIpoEscrowCampaignService` records a campaign that is already open with the offering's own parameters instead of opening it again, so repeating that step is safe.

The design record does not say what a `Pre-offering open` offering does while settlement is dormant (`AD-278` has `openCampaign` happen when a case enters that state; `AD-234` and `AD-256` keep the escrow behind activation). This change picks "open the offering, defer the campaign" so approved cases become listings at all; it is a choice for the founder to confirm, not something the record decided.

A `case_timers.pre_offering_open_handoff` job that already ran out of retries before this change stays failed (pg-boss deletes failed jobs seven days after they complete); re-queue any such job, and check for `pre_offering_open` cases that have no `Piv`, after deploying.

## Reservations wait for the offering's settlement escrow (#176)

Decided in `AD-286` (decided 2026-11-17).

Investors cannot fund an offering that cannot settle. Where the settlement bundle is configured, an offering takes reservations only while its IPO escrow campaign (`AD-256`'s one shared escrow contract, one campaign per `token_id`) was last observed `Open` on the configured escrow contract and its deadline is still ahead. Where the bundle is dormant, nothing waits for a campaign.

**Where the gate applies.** Only where the settlement bundle is configured: `CHAIN_NETWORK`, `CHAIN_RPC_URL`, `CHAIN_OPERATOR_PRIVATE_KEY` and the four contract and treasury addresses, which is the predicate `isSettlementBundleConfigured` (`src/infrastructure/blockchain/settlement-bundle.ts`) the worker already uses to decide whether the bundle exists. `src/server.ts` builds the repository's options with `offeringRepositoryOptions(environment)` (`src/modules/offering/repository/offering-repository-options.ts`), which hands `PrismaOfferingRepository` the configured `VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS` as `settlementEscrowContractAddress` where that predicate holds, and nothing where it does not (a repository built without it has no gate). That repository gives the answer to both sides: `getInvestorDetail` reports it in `settlementEscrow` (`{ gated: false }`, or `{ gated: true, escrowContractAddress, campaign }`), and `createReservation` acts on it, so the advisory `reservation.blockers` and the write path cannot disagree. The API and the worker must therefore be given the same `CHAIN_*` settings; the `&app-environment` anchor of `docker-compose.staging.yml` does that. While the bundle is dormant (`AD-234`, the launch configuration) the blocker `settlement_escrow_not_ready` is never raised, `createReservation` does not read `settlement.ipo_escrow_campaigns`, and the off-chain register launch of `PAYMENT_FLOWS.md` is unchanged.

**What "ready" means.** The campaign is open now, not open once. `settlement.ipo_escrow_campaigns` has one row per `Piv` and records the last observation: `observed_state` (`not_opened`, `open`, `successful`, `failed`), `observed_at`, and the parameters `campaignOf` reported (target, deadline, treasury, escrow contract, and the open transaction hash when this backend sent it). `isSettlementEscrowReady` (`domain/reservation-eligibility.policy.ts`) says an offering is ready only when a row exists, it was recorded for the configured escrow contract (`VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS`, compared case-insensitively: the stored form is lower case and the configured one may be checksummed), its `observed_state` is `open`, and the request's own time is before the row's `deadline_at`. The contract takes no contribution at or after its deadline, so a past-deadline `open` row is not ready even if nobody has re-read it. A resolved (`successful` or `failed`) campaign, a campaign the chain no longer shows (`not_opened`), a past-deadline campaign, a row recorded for another escrow contract and a missing row all report `settlement_escrow_not_ready` in `reservation.blockers`, and `POST .../reservations` returns `409 offering.reservation_not_available` with that blocker. The check is made a second time inside the reservation transaction, under the same `offerings` row lock as the capacity check, and the campaign row is read `FOR SHARE`: the update that marks a campaign resolved waits for a reservation transaction that has already read the row, and a reservation that was queued behind that update sees its result. The settlement module owns the row; the offering module only reads it. Nothing reads `observed_at` as an age: no hourly job keeps it fresh, and none is needed for the contract's own lifecycle (a campaign cannot resolve before its deadline, which the gate already compares with the clock).

**What the row does not follow.** It records the deadline the campaign had when it was recorded. `extendDeadline` on the contract (whose owner is still open, `C-007` item 8) is not seen by the gate: reservations close at the recorded deadline, and the operator command reports the difference. A paused escrow contract is not visible to the gate either.

**After the escrow contract is redeployed.** The row records the contract it was read from, and the gate counts it only for the configured one, so the gate does see a redeploy: after `VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS` changes, every existing row reports `settlement_escrow_not_ready`, which is the right answer, since those campaigns do not exist on the new contract and `contribute()` there would revert. Neither the command nor the handoff job replaces such a row: they refuse it (the command exits 1 and says that the stored observation was recorded for another escrow contract, and `settlement.ipo_escrow_campaign_mismatch` is logged at error level), because recording over the row would hide that the old contract's campaign, which may still hold contributions, is no longer tracked here. The step is manual, per offering: check that nothing on the old contract's campaign still has to be settled, delete the row (`DELETE FROM settlement.ipo_escrow_campaigns WHERE piv_id = '<piv_id>' AND lower(escrow_contract_address) = lower('<old address>')`; nothing references the table), and run the command again, which opens, or records, the campaign on the configured contract. Whether a redeploy should replace the rows without that step is open for the founder; this change did not decide it. Likewise, the finalizer's refresh (below) moves only a row recorded for the configured contract, so a state it reads on the new contract never rewrites a row that describes the old one.

**Opening campaigns: the operator command, no sweep.** `npm run settlement:open-ipo-escrow-campaigns` (`src/cli/open-ipo-escrow-campaigns.ts`, run from a shell inside the worker container, where the operator key is) lists every offering that is still open for reservations (`pre_offering`, no final terms published), whose `Piv` has a `token_id` and whose `ipo_end_at` is still ahead, and reads each one's campaign.

Run it from the worker container, for example `docker compose --env-file .env.staging -f docker-compose.staging.yml exec worker npm run settlement:open-ipo-escrow-campaigns` for the dry run, and the same with `-- --confirm` to open.

- Without `--confirm` it is a dry run: it reads the chain and the database, prints what it would do for each offering, and changes nothing. With `--confirm` it opens them, one offering at a time, with the same target (`target_raise_eur` in EURC base units) and deadline (`ipo_end_at`) the handoff job uses, and records what the chain then shows. An error on one offering is reported and logged (`settlement.ipo_escrow_campaign_open_failed`) and does not stop the next.
- It refuses, with exit code 1, unless the settlement bundle is configured and `CHAIN_NETWORK` is `base-sepolia` (`AD-234`: Base Sepolia until the activation gate passes). The decision is `resolveOpenIpoEscrowCampaignsStartup` (`open-ipo-escrow-campaigns-command.service.ts`), made before any database or chain client is built and covered by tests; the CLI only prints its message and exits.
- Every campaign gets the single `PIV_TREASURY_ADDRESS` as its treasury, and the command's output header says so. The per-PIV treasury (a CREATE2 Safe per PIV, `AD-278`'s addendum, `C-008` question 3) is not decided and stays open.
- A campaign already `Open` with exactly the offering's target, deadline, treasury and escrow contract is recorded without a transaction (the run is idempotent). One that is open with any other value is **refused, not adopted**: nothing is recorded, the output lists the differences, `settlement.ipo_escrow_campaign_mismatch` is logged at error level, and the exit code is 1. So is an offering whose stored row was recorded for another escrow contract (see the redeploy paragraph above). A campaign already `Successful` or `Failed` cannot be reopened and is reported as needing manual action (exit code 1); when a row exists it is moved to that state, so the offering stops being ready.
- Exit code 0 means every offering is fine or there was nothing to do; 1 means refused, or an offering failed or needs manual action (a dry run reports these too); 2 means bad arguments.

**The handoff job is a second, automatic opener, and it is not testnet-gated.** The `settlement.open_ipo_escrow_campaign` job that the offering handoff enqueues where the bundle is configured (above) uses the same service and the same comparison rules as the command: it records a matching campaign, and fails (and so retries and dead-letters, with the mismatch event) on a campaign with other parameters. It runs on its own for each offering the handoff opens, with no operator and no `ipoEscrowActivationRefusal` check, so with `CHAIN_NETWORK=base` and the bundle configured it would open campaigns on mainnet, with the single placeholder `PIV_TREASURY_ADDRESS`, which is immutable on-chain once a campaign is opened (`AD-278`; `C-008` item 5). What keeps that from happening today is `AD-234`: the bundle stays unconfigured until the activation gate passes. `AD-286` speaks of the command and the sweep and not of this job, so whether the job should also refuse a non-testnet, or give way to the command, is open for the founder; this change left it as it was. Offerings opened while the bundle was dormant got no job, so the command is how they get a campaign. No schedule opens campaigns: the hourly sweep of the original proposal is gone.

**Keeping the observation current.** The command re-reads `campaignOf` for every offering it lists, so a run also refreshes the observation. `FinalizeIpoEscrowCampaignsService` calls `recordObservedIpoEscrowCampaignState` after each read that shows a campaign that is not `Open` (and after its own `finalize()`), which moves an existing row to `successful`, `failed` or `not_opened`. It updates only a row that exists and was recorded for the configured escrow contract, an older observation never replaces a newer one, and it never throws or stops a mint: a failed write is logged as `settlement.ipo_escrow_campaign_observation_failed`.

**The operator key serialises its chain writes.** Every transaction signed with `CHAIN_OPERATOR_PRIVATE_KEY` (the finalizer's `authorizeHolder`, `mint`, `finalize` and `withdrawRaised`, and the campaign open of the job and the command) runs under one Postgres advisory lock, `pg_advisory_xact_lock(7311040002)` (`PostgresOperatorKeyLock`, `src/infrastructure/blockchain/operator-key-lock.ts`; `7311040001` is the first-admin bootstrap's). The lock is held from reading the nonce to the node accepting the transaction, and not while waiting for the receipt. The finalizer's mint attempts pin the nonce they send with, so two writers reading the same pending nonce would lose a mint, not only a transaction. Advisory locks are per database, so one database with one operator key is covered; two environments sharing a key but not a database would not be.

What is decided and not built, or not decided: the table `settlement.ipo_escrow_campaigns` is not in `CORE_TABLES.md` and needs a design-record update; the per-PIV treasury and the owner of `extendDeadline` are open (above); so are whether a redeploy should replace the rows without the manual step, and whether the handoff job should be limited to a testnet or give way to the command (both above); and the start-up guard that refuses to start with both `RESERVATION_FUNDING_RAIL_ENABLED` and the settlement bundle enabled (`AD-285`, decided 2026-11-17) is decided and not built.

## The IPO deadline (`ipo_end_at`)

An offering's reservation window ends at its case's `intake.intake_cases.ipo_end_at` (`AD-244`; `PAYMENT_FLOWS.md`: the IPO stays open until the IPO period ends). Approval sets it to the decision time plus `ipo_period_days`. Once it passes, the offering accepts no new reservations. Nothing else happens at the deadline.

- **Where it is enforced.** The rule is `isWithinIpoPeriod` in `domain/reservation-eligibility.policy.ts`. It runs in two places. The advisory `reservation.blockers` on `GET /v1/offerings/:offering_id` uses it, and so does `CreateReservationService`'s pre-check. `createReservation` also reads `ipo_end_at` again under the `offerings` row lock, through the offering's PIV and case. Both report the existing `offering_not_open` blocker and return `409 offering.reservation_not_available`. No new code was added to the wire contract.
- **Boundary.** The period is open while `now < ipo_end_at`. A request at exactly `ipo_end_at` is refused. The write path compares the deadline with the service clock's request time, the same instant the policy uses.
- **Missing deadline.** An offering whose case has no `ipo_end_at` fails closed. Approval always sets the deadline, and reverting approval clears it, so a `pre_offering` offering without one is not in a defined collecting state.
- **Extensions.** The record treats an extension as an in-place update of `ipo_end_at`. Because the lock reads it live, raising `ipo_end_at` reopens reservations with no other step. No extension endpoint exists yet.
- **Idempotent retries.** A retry that reaches the lock after the deadline is refused like a new request, the same as a retry after final terms are published.
- **Public listing.** `GET /v1/offerings` still lists a `pre_offering` offering after its deadline. It already returns `ipo_end_at`, so a client can mark the offering as closed for reservations. The record keeps an offering in pre-offering after the period ends until the founder decides to proceed, extend, or close it, and hiding it would make the offering disappear while it still awaits that decision. The reservation block is enforced server-side either way.

The deadline does not move funds or reservations. No worker job runs at `ipo_end_at`: existing reservations keep their stage and capital state, unfunded holds still lapse through the 15-minute sweep, and finalization (below) is not gated on the deadline. These are open founder decisions, not settled design:

- **Extend or close.** The record says both that an underfunded IPO is extended automatically by 30 days and that the founder decides whether to extend or close it.
- **Underfunded offering at the deadline.** What happens to it and to its funded reservations is not decided.
- **Finalization timing.** Whether finalization must wait for `ipo_end_at` once the target is reached early is not decided (`C-007`).
- **Error code.** Whether the deadline deserves its own blocker code instead of `offering_not_open` is not decided.

## Reservation creation

`POST /v1/offerings/:offering_id/reservations` creates a capacity-holding reservation and an investor-initiated Coinbase CDP onramp session in one request (`AD-255`, `AD-146`). Requires an `Idempotency-Key` header (AD-057/AD-147 — reservation funding initiation is a high-risk write, deduplicated through the shared `audit.idempotency_keys` table under the `offering.reservation.create` endpoint). Request body: `{ "amount_eur": "1000.00" }`. On success (`201`):

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

The reservation row and its first `money.money_events` row (`capital_state: "initiated"`) are written inside one transaction that also re-verifies, under a row lock on the `offerings` row, that the offering is still `pre_offering` with no final terms published (`final_offering_published_at` unset — `status` stays `pre_offering` through the reconfirmation window, so the status alone does not close reservations), that its IPO period has not ended (see ["The IPO deadline"](#the-ipo-deadline-ipo_end_at) below) and that the requested amount still fits the offering's remaining capacity (`AD-146`: the same check `GetInvestorOfferingService`'s `reservation.blockers` reports is advisory only — this is the atomic, authoritative one, sharing its rule set via `domain/reservation-eligibility.policy.ts` so the two can never disagree). A losing concurrent request gets `409 offering.reservation_not_available` (offering closed between read and write) or `422 offering.reservation_amount_exceeds_capacity` (amount no longer fits), never a silent oversell.

The onramp delivers the purchased EURC to the investor's wallet address, so that address is the one place a redirect would move money. It is read from the account's `settlement.wallet_registrations` row **only when that registration is confirmed** (`registered_at` set): a pending claim is replaceable in place by its own account (see [`docs/investor-profile.md`](investor-profile.md)), so it neither makes the payment account ready (`readiness.payment_account_ready`, blocker `payment_account_not_ready`) nor is ever handed to Coinbase. The same read runs on the replay of an idempotent request, so a replay cannot be steered to an address the account swapped in meanwhile; a confirmed registration cannot be replaced through the API (`wallet.registration_address_mismatch`), so the address a replay uses is the one the first request used. Until the watcher (or staff reconcile) confirms the registration, the reservation request is refused with `409 offering.reservation_not_available` and that blocker. `readiness.payout_account_verified` is true under the same condition, so the two flags currently move together.

After the reservation is durably created, the CDP onramp session token call happens synchronously in the request path, the same way `StartKycSessionService` calls Didit — not through a job (`AD-145` governs cross-domain *state transitions*, not a single external call whose whole purpose is "start now, hand the client a URL"). If that call fails, a `purchase_failed` money event is recorded and the error propagates; the reservation row is deliberately left in place rather than unwound, because the already-decided capacity policy (reserve immediately, auto-expire if unfunded) already covers this case identically to an investor who simply never completes the purchase.

### Retrying a reservation request (`Idempotency-Key`)

The request requires an `Idempotency-Key` header of at most 128 characters (`400 idempotency.key_required` otherwise). Two layers deduplicate it, and which one answers a repeat depends on whether the shared table holds a row for the key.

**1. The shared table (`audit.idempotency_keys`, endpoint `offering.reservation.create`, `AD-147`).** A repeat of the same request answers with the **stored first answer**, status and body, for the 48-hour retention window, without running the handler. `2xx` and `4xx` answers are stored; a `5xx` never is (#122), so a retry after a server-side failure runs the handler again. "The same request" is the body *and* its scope: the authenticated account and the offering in the path. The table's key is only `(idempotency_key, endpoint)`, so the scope is hashed together with the body: another account, or another offering, under the same key is `409 idempotency.body_mismatch`, exactly like another body, and never the first caller's stored answer (their `reservation_id` and onramp URL). Rows stored before this scoping was added have the old fingerprint, so a same-key retry of one of them within the 48-hour window answers `409 idempotency.body_mismatch` too (create, reconfirm and finalize alike); deploy it while no reservation funding is in flight (the funding rail is off, AD-285).

A stored answer carries the onramp URL of the first attempt. **That URL is not to be re-opened later**: Coinbase session tokens are single-use and expire after five minutes (`docs/coinbase-cdp-onramp.md`), while the hold lasts fifteen. The URL in a `201` is for opening immediately; a client coming back to the payment asks for a new session (next section).

**2. The reservation row (`client_idempotency_key`, unique per account, offering and key).** When the table holds no row for the key (the first attempt ended in a `5xx`, its answer could not be saved, or two identical requests raced), the request reaches the handler, and a lookup under the same `offerings` row lock that guards capacity returns the existing reservation instead of creating a second hold. The service looks the key up *before* its advisory capacity check: the offering's reserved capacity includes the hold itself, so the check would otherwise refuse the retry of a request that took the last capacity (`409 capacity_exhausted`) or more than what is left after it (`422 offering.reservation_amount_exceeds_capacity`). For an existing hold the capacity checks are skipped; every other blocker still applies, and the repository's atomic check still decides for a new hold.

A retry is served only while the stored reservation is still what the client asked for and can still be paid. It gets a fresh onramp session for the original `reservation_id` and the original `expires_at`; a retry never creates a new hold, never extends an existing one, and never revives one that has ended:

- `409 offering.idempotency_key_reused`: the key was already used for a different `amount_eur` (`AD-147`).
- `409 offering.reservation_replay_unavailable`: the stored reservation is no longer payable through a new session: it has less than five minutes of its 15-minute hold left (a session lives five minutes, see below) or is past the hold, its `reservation_stage` is no longer `initiated` (`lapsed`, `cancelled`, `awaiting_reconfirmation`, ...), or its latest `capital_state` is already funded (`eurc_reserved`, `reconfirmation_pending`, `eurc_finalized`). The same `409` is returned when the reservation lapses (the sweeper flipped its stage) or is funded while the onramp session is being created: the `eurc_purchase_pending` money event is then refused under the reservation lock and no onramp URL is handed out. The hold's age is checked before the Coinbase call only; the repository's locked write does not look at it, and the five-minute margin above is what keeps a session from outliving the hold. The client should read its reservations for the current state instead of retrying again.

If the onramp session call fails on a retry, the error is returned and no `purchase_failed` money event is recorded: only a first attempt marks a reservation failed, so the original reservation keeps its state and the client can retry again until the hold ends.

### Starting a new payment session for an existing hold

`POST /v1/offerings/:offering_id/reservations/:reservation_id/payment-session` hands a client that comes back to the payment ("Continue to payment", "Try the payment again") a **new** Coinbase onramp session for a hold it already has, without a second hold. Customer-only, behind fresh authentication like the creating request. It requires an `Idempotency-Key` header, **one fresh key per user press** (shared table, endpoint `offering.reservation.payment_session`, scope: account, offering and reservation): a sequential retry of a press whose answer was lost gets that press's session back (two identical requests in flight at once can each be served a session, as for any request that reaches the handler before the first answer is stored), the next press, with a new key, gets a new session. No request body. Response (`200`, `Cache-Control: no-store`), the same shape as the creating request's `201`:

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

`expires_at` is the hold's original expiry; the session itself lives five minutes. The rules are the retry rules above: the hold must be `initiated`, unfunded and at least five minutes short of its end (the last session is issued ten minutes into the 15-minute hold, so a session never outlives the hold), otherwise `409 offering.reservation_replay_unavailable` (read the reservations instead of retrying); the account must still pass every blocker except capacity (`409 offering.reservation_not_available` with `field_errors`); a failed provider call returns the error and never marks the hold failed; and each success records a new `eurc_purchase_pending` money event (a hold whose last attempt failed is awaiting its purchase again). A reservation that does not exist, is not this account's, or belongs to another offering is `404 offering.reservation_not_found`, and no session is requested for it.

**Why ten minutes.** A Coinbase session is valid for five minutes (`docs/coinbase-cdp-onramp.md`), so one requested at minute 13 would still be payable at minute 18, after the sweeper lapsed the hold at 15, and a purchase in between would be recorded as late evidence on a reservation that holds nothing (see [Late payments](#late-payments)). The same limit applies to a retry of the creating request that reaches the handler. The limit rests on the session lifetime the service is configured with (`sessionLifetimeMinutes`, 5): if Coinbase changes the token lifetime it has to change with it.

One limit of a new session is not closed here: a new session does not cancel the earlier one. If the first session's purchase is still in flight when the investor asks again, both can complete, and the excess EURC (it lands in the investor's own wallet) is seen by the poll as `already_funded` or, after a lapse, as late evidence.

### When the payment session cannot be started

By the time the Coinbase call is made the reservation exists. Every failure of that call is therefore a `5xx`, which the idempotency middleware never stores, so the client keeps its key and a repeat resumes the same hold instead of creating a second one:

| Provider outcome | Response | Meaning for the client |
| --- | --- | --- |
| Outage, timeout, `408`, `429`, `5xx` | `503 offering.coinbase_provider_unavailable` | Transient. Retry with backoff. |
| Unusable response | `502 offering.coinbase_provider_response_invalid` | Transient. Retry with backoff. |
| Any other `4xx` from Coinbase | `502 offering.coinbase_provider_request_rejected` (was `422`) | Retrying will not help soon. Say the payment cannot be started right now. |
| `401`/`403` | `500 offering.coinbase_provider_auth_rejected` | Our configuration. Not retryable until an operator fixes it. |
| Unusable API key secret | `500 offering.coinbase_provider_key_invalid` | Our configuration. Not retryable until an operator fixes it. |

A first attempt that fails records `purchase_failed` on the new hold; the hold stays until it lapses (the capacity policy covers it like a purchase that was never completed). The creating request's other refusals (`400`, `404 offering.not_found`, `409 offering.reservation_not_available`, `409 offering.idempotency_key_reused`, `409 idempotency.body_mismatch`, `422`) all happen before a hold is created, or concern a hold that can no longer be paid, and are final for that key. `401`, `authentication.fresh_auth_required` and `429` come from middleware ahead of the idempotency layer, are never stored, and leave the key usable.

## Unfunded reservation expiry

A `case_timers.reservation_unfunded_expiry` job (`ExpireUnfundedReservationsService`, run every minute by the worker process — the other `case_timers`/`maintenance` jobs run hourly, but a 15-minute promise needs a tighter sweep) lists every `initiated` reservation and flips any older than 15 minutes to `lapsed`, exactly like `ExpireOverdueInformationRequestsService` already does for overdue information requests. There is no separate "release capacity" step: `reserved_capacity_eur` is computed by summing reservations excluding `cancelled`/`lapsed` at read/check time, so flipping the stage is the entire release. Each expiry is idempotent (a reservation no longer `initiated` by the time the job reaches it is a no-op, not an error) and writes an `offering.reservation_lapsed` audit log entry with `actor_account_id: null`, since nothing but the timer itself acts here.

`reservation_stage` and `capital_state` are separate state machines (`AD-253`): a reservation whose latest `capital_state` already shows funded (`eurc_reserved`, `reconfirmation_pending`, or `eurc_finalized`) is never auto-expired just because `reservation_stage` is still `initiated` — that combination is normal, not a bug, since `reservation_stage` only moves forward at the later finalization step described below. `listInitiatedReservationsForTimers` reports each reservation's latest `capital_state` precisely so the sweep can apply this exclusion (`isReservationFunded`, `domain/reservation-eligibility.policy.ts`). The exclusion is re-applied a second time inside `expireReservation` itself, under the same `FOR UPDATE` lock that flips the stage, so a purchase landing between the list-time snapshot and the lock acquisition must not still sweep a funded reservation to `lapsed`. `recordMoneyEvent` takes that same reservation row lock, and both read the latest money event in a separate statement after the lock is held, so a money event and a lapse serialise. A money event is written only while the reservation is still `initiated`, and an unfunded event is never written over funded money; otherwise nothing is written.

## Advancing capital_state: the onramp transaction poll

A `case_timers.reservation_onramp_poll` job (`PollOnrampTransactionsService`, also every minute) moves `capital_state` past `eurc_purchase_pending`. When `COINBASE_ONRAMP_WEBHOOK_SECRET` is configured, a signed CDP onramp webhook triggers the same reconciliation for one reservation straight away, and the poll stays as the backstop (see [`docs/coinbase-cdp-onramp.md`](coinbase-cdp-onramp.md#webhook)). Either way the outcome goes through one recording method (`recordOnrampOutcome`), which takes the reservation's `FOR UPDATE` lock and writes a money event only while the reservation is still `initiated` and its latest event is `eurc_purchase_pending` or `purchase_failed`, never twice for the same provider transaction and `capital_state` (so a failed reservation the poll lists every minute gets one `purchase_failed` row, not one per minute), and never over a funded latest event; the poller counts a reservation as acted on only when a row was written, and a reservation that has left `initiated` comes back as `other_stage` instead (see below). It lists reservations whose latest money event is `eurc_purchase_pending` or `purchase_failed` (a failed purchase stays in the poll list so a retry can still advance it), calls `GET /onramp/v1/buy/user/{partnerUserRef}/transactions` for each (`partnerUserRef` is the reservation ID, set at session-token creation), following `next_page_key` for up to 10 pages (`MAX_ONRAMP_TRANSACTION_PAGES`), and records a new money event: `eurc_reserved` if *any* returned success covers the reservation, wherever it sits in the list, `purchase_failed` once every page has been read, nothing is still `created`/`in_progress`, and either no success covers the reservation or only failures exist, or no change at all while an attempt is still in flight, nothing has started yet, or the page cap was hit without a covering success. Each reservation is polled in isolation: a failed Coinbase lookup or money-event write is logged with its `reservation_id` and counted, and the run carries on with the rest; only after every reservation has been tried does a run with any failures throw (`OnrampPollIncompleteError`, carrying `checked`/`acted`/`failed`), so pg-boss retries it and a persistent failure still reaches the dead-letter queue. "Covers" means the purchase is EURC credited at a value within a 90% tolerance band of the reserved EUR (`isPurchaseCovering`): the onramp's fee comes out of the credited amount, so a normal purchase lands a few percent short of the reserved EUR — but a different purchased asset, a near-empty purchase, or an amount far below the reservation is real money arriving for the wrong thing and must never count as this reservation's funding; that mismatch is logged as a `purchase_failed` money event instead. This job is only registered when Coinbase credentials are configured — the one worker job so far whose sole dependency is genuinely optional, unlike the always-on `case_timers`/`maintenance` jobs. A covering success always wins over an earlier failed or non-covering attempt on the same reservation.

A purchase that succeeds only *after* the reservation's stage has already left `initiated` (`lapsed`, `cancelled`, or a stage only a funded reservation reaches) writes no money event: the recording method answers `other_stage`, and the poller and the webhook job hand it to `OtherStageOnrampOutcomeHandler`, which in the worker is `RecordOnrampLateEvidenceService`. It lists the success as late funding evidence for staff and does nothing else; see [Late payments](#late-payments). That is distinct from the sweep-race above (a purchase landing just before the expiry sweep's lock), which the repository-level re-check closes.

This section describes the model the founder has decided to leave in place until the funding path is settled (AD-285, decided 2026-11-17): `RESERVATION_FUNDING_RAIL_ENABLED` stays `false`, the chain settlement bundle stays dormant, and nothing extends the `eurc_reserved` path. Bug fixes, webhook-first evidence recording and reconciliation fixes stay valid.

### Late payments

A late payment is a Coinbase onramp **success** for a reservation whose `reservation_stage` is no longer `initiated`: it `lapsed` (the 15-minute expiry above), it was `cancelled` (an intake case closing, for one), or it is in a stage only a funded reservation reaches (`awaiting_reconfirmation`, `reconfirmed`, `finalized`), in which case this is a further payment on top of the funding already recorded.

**What the record says, and what the code does not do.** The EURC of an onramp purchase goes straight to the investor's own wallet (`AD-243`); there is no refund mechanism (`AD-243`, `AD-251`: no provider-side reversal, VistaBlox sends nothing additional); and an expired intent is not revived by a late contribution (`AD-260` step 9, `AD-266`). So nothing is **held**: VistaBlox never had the money. Nothing is **reinstated** (the reservation keeps its stage and never counts toward capacity or funded progress again), **refunded**, or **released**, and no code, route, status or alert says otherwise. There is no hold-and-review queue and no reinstate-or-refund choice to make: the founder decided on 2026-11-17 (`AD-288`, decided 2026-11-17) to keep an ops-visibility list of late funding evidence and nothing more.

**What is written.** One row in `money.onramp_late_evidence` per Coinbase transaction (unique on the provider transaction id), carrying the provider transaction id, the on-chain `txHash`, the destination wallet Coinbase reported, the reservation id, the amount and asset purchased, the state, `observed_at` and a nullable `reviewed_at`; also the reservation's stage when it was seen. The state is what the outcome would have been on a reservation still awaiting its purchase: `eurc_reserved` for a success that covers the reservation (`isPurchaseCovering`, the 90% band), `purchase_failed` for a success that does not (a different asset, or far too little), since that is still money that reached the investor. A failed attempt moved no money and is not listed. A row is not a money event: nothing that sums funded capital reads the table, and the reservation, its stage and its money events are untouched. It is written after the recording method has answered `other_stage` (which wrote nothing and has released its row lock on the reservation), in a transaction of its own that takes no reservation lock, by whichever of the signed webhook job or the poll sees the transaction first; the unique transaction id makes the second sighting insert nothing (`INSERT ... ON CONFLICT DO NOTHING`, one `offering.onramp_late_evidence_recorded` audit row for the first, with ids only). If that write fails it throws: the webhook job is retried by pg-boss, and the poll counts the reservation as failed but lists `initiated` reservations only, so for a lapse that lands between the poll's list and its lock the webhook retry is the only recovery. The table rejects an `initiated` stage, a state other than those two, a negative or NaN amount and a second row for the same transaction, and a row cannot be changed or deleted except that `reviewed_at` can be set, once (a trigger, as on `money_events` and the webhook receipts).

**Which transactions.** Every success Coinbase lists for the reservation once it has left `initiated`, in whatever order Coinbase returns the list. The poller and the webhook job first record the one transaction the list resolves to (the first covering success, else the first success). If the reservation turns out not to be `initiated` (the method answers `other_stage`, or a `duplicate` read at another stage), they offer every other success of the list to the same method, each in the state it would have been recorded in. A transaction already recorded as money in that state is a `duplicate` before the stage is looked at, so the funding transaction itself never reads as late, and one late payment already listed does not hide a later one; any other success answers `other_stage` and is listed. A failed attempt is never listed. While the reservation is still `initiated` nothing further is offered, because the method would record a `purchase_failed` row for each further uncovered success, which nobody has decided.

**What staff can do.** `GET /internal/v1/offerings/onramp-late-evidence` lists the entries, newest first (`limit` 1-100, default 25, an exclusive `after` cursor, `review_state` `unreviewed` or `reviewed`), each with the reservation's stage when seen, its stage now and why that stage reads as late (`reservation_lapsed`, `reservation_cancelled`, `reservation_funded_already`). `POST /internal/v1/offerings/onramp-late-evidence/:evidence_id/mark-reviewed` sets `reviewed_at` and writes an `offering.onramp_late_evidence_reviewed` audit row naming the staff account in the same transaction; marking an entry that is already reviewed returns it with its first review time and writes nothing; an unknown id is `404 offering.onramp_late_evidence_not_found`. Both need an authenticated staff account with the `admin_operations` role and a verified staff WebAuthn session, like the other offering-operations routes. There is no other action.

**The alert.** While at least one entry is unreviewed, the worker's hourly `maintenance.onramp_late_evidence_alert` job (owner `payments`, tier `tier_1`, `0 * * * *`; it reads the database only, so it does not depend on the Coinbase credentials) logs one structured line at `warn` with the stable `event: offering.onramp_late_evidence_unreviewed`, `severity: warn`, the job, the trace id and counts and ids only: `unreviewed_count`, `oldest_unreviewed_age_seconds`, and up to 20 `evidence_ids` oldest first. It is level-triggered, not a fire-once log: the line comes back every hour until the last entry is marked reviewed, and never carries an address, hash or amount. The gauge `vistablox_worker_onramp_late_evidence_unreviewed` follows the count. Like the wallet registry alerts, nothing delivers this line to a person yet (`docs/wallet-registration-operations.md`, "Not built: delivery"): until a delivery mechanism exists it reaches someone only if they read the worker log, or key an alert rule on the `event`.

**What it does not cover.**

- Without `COINBASE_ONRAMP_WEBHOOK_SECRET` nothing reaches a lapsed or cancelled reservation: the minute poll lists `initiated` reservations only, and there is no per-minute watch of abandoned reservations (it would cost one Coinbase call per reservation per minute for as long as it was watched); the signed webhook is what routes lapsed and cancelled reservations to this path. The poll still hands over a late success it meets itself (a lapse landing between its list and its lock).
- A webhook for a reservation this database does not know is acknowledged and logged, not listed.
- A further success on a reservation that is already funded but still `initiated` (a double payment before the reconfirmation window opens) is not listed: the recording method answers `already_funded`, which the late path does not consume (it consumes `other_stage`, AD-289), and the poller only logs it at info. Whether AD-288's "late or unmatched" covers it is not decided and is put to the founder. If the reservation moves on afterwards, that transaction is listed only if a further webhook for the same reservation arrives (the poll lists `initiated` reservations only).
- Nothing is concluded while an attempt on the reservation is still `created` or `in_progress` and no success covers it, so an uncovered late success waits for that attempt to finish: the webhook job throws and is retried (`OnrampOutcomeNotVisibleError`) rather than dropping the event.
- Retention of the list is open; so is whether staff access to it needs the time-boxing and access audit of `AD-270` and `AD-272`.
- This does not extend the funding path (`AD-285`, decided 2026-11-17): the model it sits beside, a 15-minute reservation with a Coinbase success counted as funded, is the one open conflict `C-007` is deciding.

## Closing an intake case closes its pre-offering

`POST /internal/v1/intake-cases/:case_id/close` can withdraw or reject a case that is already `pre_offering_open`, so its offering is live: listed publicly and taking reservations. The close does three things in the one transaction that moves the case to `withdrawn` or `rejected`:

- The case's `pre_offering` offering moves to `closed`. That drops it from `GET /v1/offerings`, which only lists `pre_offering`/`final_offering`, and makes `createReservation` answer `409 offering_not_open`. The offering row is locked `FOR UPDATE` exactly as `createReservation` locks it, so a reservation that was mid-flight either committed first and is cancelled by the next step, or waits and then sees `closed`.
- Every open reservation on it (`initiated`, `awaiting_reconfirmation`, `reconfirmed`) moves to `cancelled`. None of them can reconfirm or finalize against a closed offering, and cancelling them releases the capacity hold. `finalized` and already `cancelled`/`lapsed` reservations are left alone; a `finalized` one cannot exist while the case is still `pre_offering_open`.
- An `offering.closed_with_case` audit row is written per offering, listing the cancelled reservation ids. The case's own `case_withdrawn`/`case_rejected` intake event carries `closed_offering_ids` in its metadata.

No `money.money_events` row is written and nothing is refunded by the backend. In phase 1 the platform holds no investor funds and has no refund rail (`AD-240`, `AD-243`): EURC bought through the onramp stays in the investor's own wallet, and an escrow contribution is reclaimed by the investor from the escrow contract once the campaign fails (`AD-256`, `AD-258`). Notifying affected investors is not built here.

The approval handoff (`case_timers.pre_offering_open_handoff`) locks the case row before it creates the offering. If the case was closed after approval but before that job ran, the offering is created already `closed` and no escrow campaign is enqueued, so a closed case never gets a listed offering.

## The funding rail still stays closed by default

Both `GetInvestorOfferingService` and `CreateReservationService` take a `fundingRailAvailable` flag, computed once in `server.ts` as `RESERVATION_FUNDING_RAIL_ENABLED && <a configured Coinbase client>` and passed to both, so the read side and the write side can never disagree about whether reservations are open. `RESERVATION_FUNDING_RAIL_ENABLED` defaults to `false`; setting it without also configuring `COINBASE_CDP_*`/`COINBASE_ONRAMP_REDIRECT_URL` has no effect, and vice versa — either alone leaves `POST .../reservations` returning `409 funding_rail_unavailable`, deliberately, rather than a confusing half-enabled state. Even with the rail open, where the settlement bundle is configured each offering also stays closed until its settlement escrow campaign is open (see above); while the bundle is dormant that does not apply.

This codebase cannot verify Coinbase's live EUR/Base support on its own — that is exactly the category of assumption that broke the prior onramp design (see `AD-255` in the design docs' [architecture decisions](https://github.com/Vistablox-EU/vistablox-design-docs/blob/main/Backend/15-Decisions-and-Rationale/ARCHITECTURE_DECISIONS.md) and [`COINBASE_ONRAMP.md`](https://github.com/Vistablox-EU/vistablox-design-docs/blob/main/Backend/04-Payments-Financial/COINBASE_ONRAMP.md)). Before setting `RESERVATION_FUNDING_RAIL_ENABLED=true` in any environment, a human with real Coinbase CDP credentials should confirm, against the live API (not documentation):

1. `GET /onramp/v1/buy/options?country=<the investor's country>` lists `EUR` among `payment_currencies` and lists a `EURC`-on-`Base` combination among `purchase_currencies`/`networks`;
2. a real `POST /onramp/v1/token` + hosted-purchase-page round trip actually completes for a small test amount, end to end, on the configured `COINBASE_ONRAMP_BLOCKCHAIN`; and
3. the configured `COINBASE_CDP_API_KEY_ID`/`COINBASE_CDP_API_KEY_SECRET` are the intended environment's own credentials (sandbox for anything but production), since nothing in this codebase enforces that separation.

This is a one-time, per-environment gate, not a runtime check — no code here polls Coinbase's own capability endpoint before serving a reservation request, since that would add latency and a new failure mode to every request for a fact that changes rarely, if ever, once confirmed.

See [`AD-255`](https://github.com/Vistablox-EU/vistablox-design-docs/blob/main/Backend/15-Decisions-and-Rationale/ARCHITECTURE_DECISIONS.md) for the full provider decision and its "Still Open" list, and `docs/coinbase-cdp-onramp.md` for the client's exact REST surface.

## Offering finalization is a three-stage flow, not one action

`PAYMENT_FLOWS.md`'s "Phase-1 Final Offering Settlement Flow" and `AD-214`'s mandatory 168-hour reconfirmation window mean "finalizing" an offering is never a single atomic step: the founder's own decision only **publishes** locked final terms and opens a window; each investor must separately and explicitly **reconfirm** during that window; only once the window closes does a scheduled batch **commit** — and only reconfirmed reservations become positions. `offerings.status` stays `pre_offering` for the entire publish-and-reconfirm period; it becomes `final_offering` only at the very end, when the commit batch runs. The three stages below are documented in the order they occur.

### 1. Publishing final terms (founder-triggered)

`POST /internal/v1/offerings/:offering_id/finalize` is the founder's "proceed" decision from `AD-244`/`AD-245`: once an offering has fully collected `target_raise_eur` (`ipo_value_eur`), the founder chooses to proceed to tokenization, extend the `ipo_period`, or close the case — this endpoint implements only "proceed." Extend and close have no endpoint yet; see ["The IPO deadline"](#the-ipo-deadline-ipo_end_at). Gated identically to intake's founder-decision endpoints: `admin_operations` role plus verified staff WebAuthn. Requires an `Idempotency-Key` header (AD-057/AD-147 — a finalization-batch action; endpoint `offering.finalize`). Request body: `{ "founder_review_notes": "..." }` (required, matching `RecordFounderDecisionService`'s/`CloseCaseService`'s own convention). Response (`200`):

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

Everything eligibility-relevant is re-verified atomically inside one transaction, under a row lock on the `offerings` row, mirroring `createReservation`'s own `AD-146` discipline rather than trusting an advisory read: `target_raise_eur` must still be fully funded (`AD-245` — no partial-funding path, so this is a hard `>=` gate, not the founder's discretion), the offering must still be `pre_offering`, final terms must not already be published, and the offering's current disclosure pack must be complete (every one of the 11 mandatory document types, `isCompleteDisclosurePack` — see "Disclosure-pack authoring" below). That last check exists because `PAYMENT_FLOWS.md`'s Phase-1 Final Offering Settlement Flow step 4 bundles "publishes the locked final package" together with emitting `final_offering_published_at` — the reconfirmation window must never open against a pack no investor could actually act on. A losing request gets `409 offering.finalization_target_not_reached`, `409 offering.finalization_not_available` (not open, or already published), `409 offering.finalization_disclosure_pack_incomplete`, or `404 offering.not_found` for an unknown `offering_id`.

For every reservation still `reservation_stage: "initiated"` on the offering, the same transaction locks the reservation row (`FOR UPDATE OF reservation`, alongside the offering lock) and either:

- **funded** (latest `capital_state` is `eurc_reserved`, `reconfirmation_pending`, or `eurc_finalized`) → moves the reservation to `reservation_stage: "awaiting_reconfirmation"` and records a `reconfirmation_pending` money event; or
- **not funded** (reserved but never completed payment — possible even though the *offering's total* is fully funded, if some investors reserved but others' purchases covered the shortfall) → moves the reservation to `reservation_stage: "cancelled"`.

No position is created here. The transaction also sets `final_offering_published_at`, `platform_rights_end_at`, and `effective_rights_end_at` on the offering (168 hours after publication — `computeEffectiveRightsEndAt`, `domain/finalization.policy.ts`; `PAYMENT_FLOWS.md`'s "Effective Investor-Rights Window Override" defines `effective_rights_end_at` as the max of every applicable investor-rights window, but no broader statutory/supplement-based rights table is documented anywhere yet to compute that max over, so this codebase uses the 168-hour platform default directly). `offerings.status` is deliberately left untouched — it stays `pre_offering`.

### 2. Investor reconfirmation (investor-triggered, during the open window)

`POST /v1/offerings/:offering_id/reservations/:reservation_id/reconfirm` is each investor's own explicit action, customer-only (same auth as the rest of `offering.router.ts`). Requires an `Idempotency-Key` header (AD-057/AD-147 — investor reconfirmation submission; endpoint `offering.reservation.reconfirm`; the request itself posts no body). Response (`200`):

```json
{
  "data": {
    "reservation_id": "reservation_...",
    "status": "reconfirmed",
    "reconfirmed_at": "2026-09-03T12:00:00.000Z",
    "disclosure_pack_version": 2
  }
}
```

Atomically, under a shared lock on the offering row (so a concurrent materiality reset or pack republish, which both lock the offering `FOR UPDATE`, cannot interleave) and then a row lock on the reservation: ownership is checked (`account_id` must match the caller), the reservation must be `reservation_stage: "awaiting_reconfirmation"`, the offering's `effective_rights_end_at` must not have passed yet, and — `AD-037`: "An investor must not be able to reconfirm against an incomplete, draft, or superseded pack" — the offering's current disclosure pack must have every one of the 11 mandatory document types (`isCompleteDisclosurePack`, `domain/disclosure-pack.policy.ts`; an offering with no current pack at all fails this the same way, since an empty set is never complete). This check is largely defensive by the time reconfirmation runs: `publishFinalOfferingTerms` (stage 1) already requires a complete pack to open the window at all, so the only realistic way this fires here is a later republish (e.g. a materiality-triggered one) that lands incomplete after publish already succeeded. Completeness alone is not enough after a materiality reset, though: the current pack must also be at least the version every reset on the offering requires (`materiality_records.required_disclosure_pack_version`, see the materiality section below; `satisfiesRequiredDisclosurePackVersion`, `domain/disclosure-pack.policy.ts`). Until staff republish a complete pack at or above that version, the pre-event pack is still current but stale, and reconfirming against it is refused. A nonexistent reservation and one owned by someone else both report the same `404 offering.reservation_not_found` — deliberately, so a reservation ID never leaks whether it exists to someone who doesn't own it. The wrong stage is `409 offering.reservation_not_awaiting_reconfirmation`; a closed window is `409 offering.reconfirmation_window_closed`; an incomplete pack is `409 offering.reconfirmation_disclosure_pack_incomplete`; a complete pack that predates an unresolved materiality reset is `409 offering.reconfirmation_disclosure_pack_outdated` (incompleteness is checked first). On success the reservation moves to `reservation_stage: "reconfirmed"`, `reservations.reconfirmed_disclosure_pack_id` records the exact pack the investor reconfirmed against (the response returns its `disclosure_pack_version`), and an audit log entry records the same pack's ID and version (`PAYMENT_FLOWS.md`: "Reconfirmation must reference a specific disclosure-pack version and that version must remain downloadable for audit purposes").

Reconfirming does **not** yet create a position — it only marks the reservation ready for the commit batch below. `PAYMENT_FLOWS.md`'s "Silence rule" is explicit that no action is the terminal outcome for a reservation that never reconfirms: "No reconfirmation by expiry means the reservation lapses rather than silently finalizing."

### Reconfirmation-window reminders (scheduled batch, throughout the open window)

`AD-214`: "The 168-Hour Reconfirmation Window Gets A Scheduled Reminder Job, Not Just The Single Notification At Window Open" — `PAYMENT_FLOWS.md`'s Withdrawal/Cancellation Window table names the same stakes-asymmetry `AD-213` already applied to KYC renewal reminders: "a lapsed reservation loses the investor's committed capital opportunity." The hourly `case_timers.offering_reconfirmation_reminders` job (`SendReconfirmationRemindersService`, `src/worker.ts`) emails every reservation still `reservation_stage: "awaiting_reconfirmation"` on an offering with published final terms, at a `platform.settings`-configurable cadence (`offering.reconfirmation_reminder_interval_hours`, seeded to `48`) — never once a reservation is `"reconfirmed"`, `"lapsed"`, or `"finalized"`.

Unlike the KYC renewal reminder (`isRenewalReminderDue`, which counts back a fixed lead time from a single known due date), a reconfirmation reminder repeats indefinitely until the window closes, so there's no one calendar date to match against. `isReconfirmationReminderDue` (`domain/reconfirmation-reminder.policy.ts`) instead derives due-ness from time elapsed since the last reminder actually sent — or since `final_offering_published_at`, if none has been sent yet — compared against `effectiveRightsEndAt`. That makes it robust to a missed or delayed job tick: an overdue reminder stays due until it's actually sent, rather than being silently skipped once its one matching instant passes. "Last reminder actually sent" is derived from the `audit.audit_log` row each send writes (`offering.reconfirmation_reminder_sent`, `resourceType: "reservation"`) rather than a new column, the same general-purpose-event-history use of the audit log `AD-152`'s `trace_id` already establishes elsewhere. A reservation with no contact email on file is skipped without failing the run (matching every other reminder job's `contactEmail: null` handling) and is not counted as acted-on.

The single notification `PAYMENT_FLOWS.md`'s Withdrawal/Cancellation Window table names separately — the window's `Start event` meaning "final terms are locked, the final package is visible in-app, **and investor notification is sent**," which `AD-214`'s own decision text frames as running "in addition to — not instead of" this repeating reminder job — is also now built, as its own AD-145 cross-domain handoff rather than a synchronous send inside the founder's `/finalize` request. Inside the same transaction that moves reservations to `awaiting_reconfirmation`, `publishFinalOfferingTerms` durably enqueues `case_timers.offering_reconfirmation_window_opened` (`enqueueTransactionalJob`, the same pattern `case_timers.pre_offering_open_handoff` already established for intake-to-offering) with the offering ID and the list of reservation IDs that just moved — never a synchronous email in the founder's own request, and never enqueued at all when nothing moved (an all-cancelled publish, though `target_not_reached` would already have blocked that case in practice). The consumer (`NotifyReconfirmationWindowOpenedService`) re-resolves each reservation's contact email and window end from the database rather than trusting the payload — the same "never trust a payload snapshot" discipline `OpenOfferingForApprovedCaseService` already applies — and is itself replay-safe: whether a notification was already sent is derived from the same `audit.audit_log` general-event-history pattern the reminder job uses (`offering.reconfirmation_window_opened_notification_sent`), so a pg-boss retry or duplicate delivery after the audit row exists sends nothing; the email and the audit row are two separate steps, though, so a retry after a failed audit write sends the email again.

### 3. Window-close commit (scheduled batch, not a person)

Once `effective_rights_end_at` passes, the hourly `case_timers.offering_reconfirmation_window_close` job (`CommitOfferingFinalizationService`, `src/worker.ts`) is the only remaining path to a `settlement.position_ledger` row. Hourly, not per-minute like the 15-minute reservation-expiry sweep: the window is 168 hours (`AD-214`), so per-minute precision buys nothing an investor would notice. For each `pre_offering` offering with published final terms, once its window has closed, a single transaction locks the offering row, re-verifies the window is actually closed (`409`-equivalent internal conflict `window_still_open` otherwise — the scheduled check and the transaction's own re-check can disagree only under a clock/timing race, and the row lock is what's authoritative), then locks every reservation still `awaiting_reconfirmation` or `reconfirmed` on that offering and either:

- **reconfirmed** → creates one `position_ledger` row, moves the reservation to `reservation_stage: "finalized"`, and records an `eurc_finalized` money event; or
- **awaiting_reconfirmation** (never reconfirmed) → moves the reservation to `reservation_stage: "lapsed"` — the same terminal stage the 15-minute unfunded-reservation sweep uses, reused rather than inventing a second "expired" stage for the same underlying idea (silence).

A position's `unit_count` and `cost_basis_eur` are both set to the reservation's own committed `amount_eur` — a deliberate 1-unit-per-EUR convention (`costBasisToUnitCount`, `domain/finalization.policy.ts`), decided because no other pricing model is recorded anywhere in the architecture (`ARCHITECTURE_DECISIONS.md`/`CORE_TABLES.md` name total approved supply and a EUR-to-units conversion as an explicit, still-open gap under `AD-238`). This rule applies only to investor-subscribed positions from a real cash reservation; it says nothing about the original owner's retained position, which has no cash cost basis to convert and remains that same unresolved `AD-238` gap. `holder_wallet_address` is copied from the investor's `settlement.wallet_registrations` row as a convenience (`AD-241`'s own framing — "not a second source of truth"), but **only from a confirmed registration** (`registered_at` set; the join in `commitOfferingFinalization` carries `AND wallet.registered_at IS NOT NULL`). A pending claim proves nothing about who controls the address and its own account may still replace it, and this column is where operating distributions pay, so a pending claim never reaches it: a reservation whose account has no confirmed wallet still commits, with a `NULL` holder address, which the distribution service skips (the design record keeps the column null until address proof). Since reservation creation now requires a confirmed wallet (see the onramp paragraph above), that only happens for a reservation written around the service; nothing updates `position_ledger` rows after the fact, so the future activation step has to take the address from the then-confirmed registration, see [`docs/investor-profile.md`](investor-profile.md); `position_status` stays `pending_internal_settlement`, since nothing here touches the chain (`AD-234` keeps production blockchain settlement dormant) or attempts to mint or transfer a token (`AD-247`: only the PIV mints, using its own signers).

Only now does the transaction set `offerings.status = "final_offering"` — the one and only place in this codebase that ever does so.

Out of scope for all three stages above, and not built: any per-jurisdiction override of the 168-hour platform default (no such table is documented — see `AD-040`/`PAYMENT_FLOWS.md`'s "Effective Investor-Rights Window Override"). Locking reservation rows in each stage blocks a concurrent expiry sweep, a concurrent later stage, or a concurrent onramp poll from racing that same reservation: the poll records its outcome under the same `FOR UPDATE` lock on the reservation row (see [late payments](#late-payments)).

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

What the endpoint does mechanically, atomically, under a row lock on the offering (`AD-146` discipline): a request is only accepted while the offering is between publish and commit (`final_offering_published_at` set, `status` still `pre_offering` — the same window `reconfirmReservation` itself operates in; `404 offering.not_found` for an unknown offering, `409 offering.materiality_classification_not_available` outside that window). It always inserts a `materiality_records` row and a generic audit-log entry (`offering.materiality_classified`), whatever the classification — `AD-038`: "must still be logged" applies even to `non_material` changes. `reset_triggered` is computed from `classification`, never accepted as a separate input: `per_se_material` and `reviewed_material` are always `true`, `non_material` is always `false` (`PAYMENT_FLOWS.md`'s Material-change rule: "Any material change resets the full 168-hour window and invalidates prior reconfirmations"; `AD-046`: reviewed-material thresholds are "escalation floors, not safe harbors," so a threshold-triggering change can never be waived down to non-material). When triggered, every reservation currently `reservation_stage: "reconfirmed"` on the offering moves back to `"awaiting_reconfirmation"` (clearing `reconfirmed_at` and `reconfirmed_disclosure_pack_id`) — a reservation still only `"awaiting_reconfirmation"` has nothing to invalidate and is left untouched — and `platform_rights_end_at`/`effective_rights_end_at` are both recomputed as a **fresh** 168 hours from the classification instant, not merely extended from the old boundary. A reset also stores `required_disclosure_pack_version` on the record: one more than the highest pack version the offering has ever published (so the pack current at classification time, and any older one, can never satisfy it). Reconfirmation stays blocked until a complete pack at or above the highest required version among the offering's reset records is current. A `non_material` record leaves the column `NULL` and gates nothing. Reusing the same `effective_rights_end_at` field the window-close job reads means a reset landing after the window's old boundary but before that hourly job has actually run correctly reopens the window rather than racing a premature commit.

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
    "reservations_reset": 2,
    "required_disclosure_pack_version": 3
  }
}
```

Every created record also appears immediately in the investor-facing `change_log` (`GET /v1/offerings/:offering_id`'s response) — that read path already existed before this endpoint did, so no separate wiring was needed on the read side.

**Republishing stays a manual staff step, but reconfirmation enforces it.** `AD-038` also states a per-se-material change "always resets the disclosure pack." This endpoint does not publish a pack itself: the updated document content (what changed, and its `document_ref`) is not something a materiality classification's `change_description` free text can supply, so republishing is a separate staff action (`POST /internal/v1/offerings/:offering_id/disclosure-packs`). Instead, every reset (`per_se_material` and `reviewed_material` alike, since `PAYMENT_FLOWS.md` says any material change "invalidates prior reconfirmations") records the pack version it requires, and reconfirmation refuses with `409 offering.reconfirmation_disclosure_pack_outdated` until a complete pack at that version is published. The consequence is deliberate: if staff never republish, nobody can reconfirm, and every reservation lapses when the reset window closes. `required_disclosure_pack_version` is an addition to `CORE_TABLES.md`'s `materiality_records`, as is `reservations.reconfirmed_disclosure_pack_id`. Rows that existed before the column was added were backfilled with one more than the highest pack version published at or before their `classified_at`.

## Disclosure-pack authoring

`POST /internal/v1/offerings/:offering_id/disclosure-packs` publishes a new `disclosure_packs` version and immediately supersedes whatever was previously current (`is_current: false`, `superseded_at` set) — staff-gated identically to `/finalize` and `/materiality-records` (`admin_operations` role plus staff WebAuthn). Before this endpoint existed, nothing in this codebase could create a disclosure pack at all: `DisclosureDocumentStore` (the MinIO wrapper) only ever had a `.get()` method, `DisclosureDocumentRepository` only ever had a read path, and no intake-handoff or other flow ever wrote a `disclosure_packs` row — every disclosure pack in this codebase's tests was hand-seeded directly through Prisma, which is also, in effect, the only way one has ever existed in a real environment. That mattered beyond `AD-038`'s reset case: `hasDisclosurePack`/the `disclosure_pack_unavailable` blocker already gates *ordinary* reservation creation, well before an offering ever reaches publish or reconfirm.

Request body:

```json
{
  "documents": [
    { "document_type": "ecsp_kiis", "document_ref": "documents/kiis-v2.pdf" },
    { "document_type": "final_terms_sheet", "document_ref": "documents/terms-v2.pdf" }
  ]
}
```

`document_type` is a closed enum of the 11 document kinds `AD-037`/`VISTABLOX_BACKEND_DISCUSSION.md`'s "Mandatory Core Pack" table names (`ecsp_kiis`, `priips_kid`, `final_offer_summary`, `final_terms_sheet`, `issuer_offeror_structure_sheet`, `investor_rights_payout_waterfall_summary`, `risk_factors_summary`, `property_appraisal_summary`, `fees_costs_tax_liquidity_summary`, `withdrawal_cancellation_supplement_rights_notice`, `full_prospectus`) — rejected with `422` if duplicated within one request. `document_ref` is the `document_ref` an earlier upload to *this* offering returned (see "Uploading disclosure documents" below): the object key in the disclosures bucket. It is no longer a trusted string. Inside the publish transaction, under the same `offerings` row lock, every ref is resolved against `platform.stored_documents` — it must be an accepted (`upload_status = 'accepted'`), non-deleted row with this `offering_id` in the disclosures bucket — and a request quoting anything else is refused as a whole with `422 offering.disclosure_document_unknown`, whose `field_errors` name each offending entry (`documents.<index>.document_ref`); nothing is written. A process started without document storage (`MINIO_*`/`MINIO_DISCLOSURES_BUCKET` unset) accepts no ref at all, since it cannot have taken an upload either. `is_core_reading` is never client-supplied: it's computed server-side from `document_type` (`isCoreReadingDocumentType`, `domain/disclosure-pack.policy.ts`), true for every mandatory type except `full_prospectus` — CORE_TABLES.md's own comment on that column already frames this as deterministic ("false only for the full prospectus").

This is deliberately **one reusable staff primitive**, not logic wired into any single flow. The documented model implies at least three distinct moments a new version gets published — an initial pre-offering pack (whatever `hasDisclosurePack` gates ordinary reservations on), the version-locked pack tied to `final_offering_published_at` (`AD-037`), and a republished pack after a materiality reset (`AD-038`, still a manual follow-up call — see the previous section) — but all three are the same mechanical action, so this endpoint doesn't hard-code which moment it's being called for. It only requires the offering still be `pre_offering` (`404 offering.not_found` for an unknown offering, `409 offering.disclosure_pack_not_available` otherwise — `AD-046` puts post-finalization content changes through a separate amendment/consent path this codebase does not build).

Response (`201`):

```json
{
  "data": {
    "disclosure_pack_id": "pack_...",
    "offering_id": "offering_...",
    "version": 2,
    "published_at": "2026-09-06T12:00:00.000Z",
    "documents": [
      { "document_id": "document_...", "document_type": "ecsp_kiis", "is_core_reading": true },
      { "document_id": "document_...", "document_type": "final_terms_sheet", "is_core_reading": true }
    ],
    "is_complete": false,
    "superseded_pack_id": "pack_..."
  }
}
```

### Uploading disclosure documents

The files a pack is built from are uploaded through the same staff-gated router (`admin_operations` role plus staff WebAuthn), one file per request, the way intake's case-document upload already works — a raw body, described by headers, not a multipart form. Routes are mounted only when document storage is configured (`MINIO_ENDPOINT`/`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`/`MINIO_DISCLOSURES_BUCKET`; the same gate the investor download's `MinioDisclosureDocumentStore` has), exactly as intake's upload routes are.

`POST /internal/v1/offerings/:offering_id/documents` — body: the file bytes. Headers:

- `Content-Type`: one of `application/pdf`, `image/jpeg`, `image/png`, `image/webp`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (intake's allowlist, unchanged); anything else is `422 offering.document_mime_unsupported`.
- `X-Document-Type`: one of the 11 `document_type` values above; anything else is `422 offering.document_type_unsupported`.
- `X-Original-Filename`: optional, the name the file had on the staff member's machine, for display only (the storage key never contains it). Headers cannot carry every character a filename can, so a value containing `%` is percent-decoded (`decodeURIComponent`), falling back to the raw header when it is not valid encoding; a value without `%` is taken verbatim. Capped at 255 characters; defaults to `document`.

The body is capped at 100 MB (`413 offering.document_too_large`), must not be empty (`422 offering.document_empty`), is SHA-256 hashed while streaming, and is handed to ClamAV before any byte is kept: `503 offering.document_scanner_unavailable` when the scanner cannot be reached (fail closed — nothing is stored), `422 offering.document_malware_detected` on a hit. `404 offering.not_found` for an unknown offering. A clean file is written to the disclosures bucket under `offerings/{offering_id}/{document_id}` (`objectKey`, `src/infrastructure/storage/storage-buckets.ts` — a server-generated key, the same one the investor download later reads through `MinioDisclosureDocumentStore.get`), then a `platform.stored_documents` row is created (`offering_id`, `document_type`, bucket, key, content type, size, checksum, `upload_status: "accepted"`, `classification: "disclosure"`, `original_filename`) together with an `offering.disclosure_document_uploaded` audit-log entry in one transaction; if that transaction fails the object is deleted again rather than left orphaned. Response (`201`):

```json
{
  "data": {
    "document_id": "doc_...",
    "document_type": "final_terms_sheet",
    "document_ref": "offerings/offering_.../doc_...",
    "content_type": "application/pdf",
    "size_bytes": 184233,
    "sha256_checksum": "…64 hex…",
    "original_filename": "Final terms – v1.pdf",
    "uploaded_at": "2026-11-13T10:00:00.000Z"
  }
}
```

`document_ref` is the value to quote in `POST .../disclosure-packs`. Uploading does not publish anything by itself: an upload that is never quoted in a pack is simply never visible to an investor, and re-uploading a corrected file is a new upload with a new `document_ref` — there is no replace-in-place, so a pack version that quoted the old key keeps pointing at the bytes investors actually saw.

`GET /internal/v1/offerings/:offering_id/documents` lists the offering's accepted, non-deleted uploads, newest first, optionally narrowed with `?document_type=` (`422` for a value outside the enum; `404 offering.not_found` for an unknown offering). Response (`200`):

```json
{
  "data": [
    {
      "document_id": "doc_...",
      "document_type": "final_terms_sheet",
      "document_ref": "offerings/offering_.../doc_...",
      "content_type": "application/pdf",
      "size_bytes": 184233,
      "original_filename": "Final terms – v1.pdf",
      "uploaded_at": "2026-11-13T10:00:00.000Z",
      "published_in_pack_id": "pack_..."
    }
  ]
}
```

`published_in_pack_id` is the most recent `disclosure_packs` row (highest version, current or superseded) whose documents reference this `document_ref`, or `null` for an upload no pack has quoted yet — what the admin uses to tell "uploaded" from "published".

`GET /internal/v1/offerings/:offering_id/documents?document_ref=<key>` streams that one upload back to staff (`Content-Type` and `Content-Length` from the metadata row, `Cache-Control: private, no-store`, `Content-Disposition: inline` with a sanitised filename, `X-Content-Type-Options: nosniff` — the same shape as intake's `GET /:case_id/documents?document_ref=`). A ref that is not one of this offering's accepted uploads is `404 offering.document_not_found`; a row whose object has gone missing from storage is `503 offering.document_storage_inconsistent`.

`is_complete` reports whether every one of the 11 mandatory document types is present in *this* pack — informational only, not a hard gate on *this* endpoint itself. A pack published before final terms is legitimately allowed to be partial (`hasDisclosurePack` only ever required at least one document, never all eleven), so requiring full completeness on every publish would make the initial pre-offering moment unbuildable. `AD-037`'s "must be blocked if the pack is incomplete" is enforced downstream, in two places, both re-deriving completeness from the offering's current pack under their own row lock rather than trusting a stale `is_complete` value from whenever the pack was published: `publishFinalOfferingTerms` (stage 1 — see above), the primary gate, since it requires a complete pack before it will open the reconfirmation window at all; and `reconfirmReservation` (stage 2), defensively, for the narrower case of a pack that regresses to incomplete via a later republish after publish already succeeded.

## Featured flag and media

`PATCH /internal/v1/offerings/:offering_id/presentation` sets how an offering is presented to investors. It uses the same staff gate as the other offering-operations routes: the `admin_operations` role plus a staff WebAuthn session. The body is a strict object with at least one of:

- `featured` (boolean): featured offerings sort first in `GET /v1/offerings`, then newest first. There is no rank; the flag is a single tier.
- `media` (object or `null`): `{ "hero_url": string | null, "gallery_urls": string[] }`. `null` clears all media. Each URL must be an absolute `https` URL of at most 2048 characters; the gallery holds at most 20 distinct URLs, in display order. The object replaces the stored media as a whole.

A key left out of the body keeps its stored value. The route works in every offering status, is not a materiality event, and does not take an `Idempotency-Key`, because repeating the same request leaves the same state. It returns `200` with `{ "data": { "offering_id", "featured", "media" } }`, or `404 offering.not_found`.

The update locks the offering row and writes an `offering.presentation_updated` audit row whose `changes` hold the request `trace_id` and the `before` and `after` state in the wire shape above.

Media is stored on `offering.offerings` (`hero_image_url`, `gallery_image_urls`) and served under `property.media` in both the public list and the investor detail. The response shows `media: null` when there is no hero image and the gallery is empty. The API only stores links to images hosted elsewhere: it does not upload or serve image files, and no MinIO URL is ever used here (see [`document-storage.md`](document-storage.md)).
