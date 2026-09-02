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

## The funding rail still stays closed by default

Both `GetInvestorOfferingService` and `CreateReservationService` take a `fundingRailAvailable` flag that defaults to `false`, so `POST .../reservations` currently returns `409` with `funding_rail_unavailable` even though the endpoint — and now the expiry sweep above — both exist and are enforced regardless of the flag. Turning it on still needs:

1. a scheduled poll of Coinbase's buy-transaction-status endpoint to advance `capital_state` past `eurc_purchase_pending` (no onramp/offramp webhook exists to push this — confirmed against CDP's own docs, not assumed; not yet built); and
2. live confirmation that Coinbase CDP actually supports EUR and the configured network for this account — the same category of "verify before flipping the switch" risk that broke the prior Stripe-based design, named as still open in `AD-255`.

See [`AD-255`](https://github.com/Vistablox-EU/vistablox-design-docs/blob/main/Backend/15-Decisions-and-Rationale/ARCHITECTURE_DECISIONS.md) for the full provider decision and its "Still Open" list, and `docs/coinbase-cdp-onramp.md` for the client's exact REST surface.
