# Investor profile

`GET /v1/investor-profile` returns the authenticated customer's consolidated profile. It implements the documented cross-reference and deliberately does not introduce a table of its own for any of investor-profile's own entities. It does, since Phase 7, read from one table this module owns: a local, event-driven projection of KYC eligibility — see the note on eligibility below and [`kyc-eligibility-read-model.md`](kyc-eligibility-read-model.md).

## Durable aggregate

The repository reads the existing source-of-truth records in one account-scoped query:

- account status, protected contact email, membership date, and linked login methods from `account`
- local eligibility, declared country codes, proof-of-address state, and renewal dates from this module's own KYC eligibility projection (`account.kyc_eligibility_projection`, kept in sync with `identity`'s own table via `identity.kyc_eligibility_changed` events and a periodic reconcile pass — not a live read against `identity` itself; see [`kyc-eligibility-read-model.md`](kyc-eligibility-read-model.md))
- reservation and non-redeemed position counts from `money` and `settlement`
- wallet registration progress and distinct investment/payment/payout readiness from `settlement`, this same eligibility projection, and linked-login state

The response does not include raw wallet addresses, monetary balances, KYC evidence, provider payloads, session data, or notification preferences. It is customer-only, uses the authenticated account ID rather than a path parameter, and sends `Cache-Control: no-store`.

## Reservation history and current portfolio

Two customer-only, cursor-paginated subresources continue the profile aggregate without placing unbounded arrays on the overview response:

- `GET /v1/investor-profile/reservations?limit=20&after=...` returns reservation terms, lifecycle timestamps, a residential-property summary, and only the latest `money.money_events` capital-state projection. Provider names and provider references are excluded.
- `GET /v1/investor-profile/positions?limit=20&after=...` returns canonical off-chain holdings whose status is `pending_internal_settlement` or `active`. Redeemed positions and holder wallet addresses are excluded from this current-portfolio view.

Limits default to 20 and are capped at 100. Cursors include their resource kind, so cursors cannot be reused across the reservation and position endpoints. Reservations sort newest-first by creation time and ID. Positions sort active timestamps newest-first, with pending positions after activated positions.

## Verified display-name cache

Didit remains authoritative for identity names. VistaBlox does not persist them in PostgreSQL. The whole cache lives on the standalone KYC service now (`GetKycDisplayProfileService`, reached through `KycServiceGateway` the same way `/v1/kyc` itself is) — this API holds neither the Redis connection nor a Didit client for it. When both Didit and the KYC service's own `PROFILE_CACHE_URL` are configured there, an approved, correlated individual decision may populate a server-side Redis/Valkey entry containing exactly:

- `given_name`
- `family_name`
- `full_display_name`
- `didit_profile_last_synced_at`

Entries use the opaque key `kyc_display:{account_id}`, refresh after six hours, and expire after 24 hours. Configure the managed EU cache without routine backups. Unknown fields make an entry invalid and cause deletion. Starting a new baseline KYC session or receiving a correlated baseline KYC webhook invalidates the account's cached names — unchanged by this move, since that invalidation already ran inside the KYC service.

If Redis/Valkey is absent or unavailable, or the KYC service itself doesn't respond, the endpoint continues to return the durable aggregate with `display_profile: null`. It does not bypass the required cache by turning Didit into a normal profile-read dependency. A transient Didit refresh failure may use an existing unexpired cache entry — but only for a request the KYC service itself serves; this API keeps no cache of its own to fall back to if that internal call fails outright.

## Response sections

The response includes `account_id`, account/contact metadata, optional `display_profile`, linked `login_methods`, the local `kyc` overview, investment counts, separate readiness flags, and wallet-registration status. `investment_eligible` requires an active account, current eligible KYC, and both Google and email/password recovery paths. A wallet request makes `payment_account_ready` true; confirmed registration makes `payout_account_verified` true. Dates are UTC ISO 8601 values. Proof-of-address state is projected as `expired` at read time when its stored current-until timestamp has elapsed.

## Wallet registration

`POST /v1/investor-profile/wallet` records the DB-recording half of AD-241's wallet-provisioning flow: the mobile app generates a signing key locally, derives the Base-compatible public address, and sends only that address here. This endpoint requires current KYC eligibility (AD-241: "wallet provisioning is meant to happen right at KYC approval, before any reservation") and an active account; it does not require the broader `investment_eligible` composite, since linking recovery-capable login methods is a separate concern from being cleared to hold a wallet.

A server-generated, opaque `registration_commitment` (32 random bytes, base64url) is returned alongside the stored `wallet_address`, `status` (`pending` until confirmed, `registered` once `registered_at` is set), and both timestamps. Creation is idempotent by account: replaying the same `wallet_address` for an account that already has it registered returns the existing row rather than erroring. Submitting a *different* address for an account that already has one is rejected (`409 wallet.registration_address_mismatch`) — AD-241 treats creation and address change/recovery as separate code paths, and this endpoint only implements the former. An address already claimed by a different account is also rejected (`409 wallet.address_already_claimed`); `settlement.wallet_registrations.wallet_address` carries the same uniqueness as a database constraint.

**Deliberately out of scope here:** AD-241's steps 6–10 — returning "unsigned registration-call data" for an on-chain registration transaction, and later observing that transaction's confirmation to set `registered_at` — are not implemented. `AD-234` keeps production blockchain settlement dormant pending a written-counsel memo, and preparing real contract calldata against a not-yet-authorized chain layer would be exactly the kind of premature work that gate exists to prevent. `registered_at` stays `null` until that gate clears and a future on-chain-event observer is built; reservation creation does not need it — the readiness check this profile already exposes (`payment_account_ready`) only requires a wallet row to exist, not on-chain confirmation.
