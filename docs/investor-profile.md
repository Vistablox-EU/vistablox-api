# Investor profile

`GET /v1/investor-profile` returns the authenticated customer's consolidated profile. It implements the documented cross-reference and deliberately does not introduce a table of its own for any of investor-profile's own entities — see the note on eligibility below for how it reads identity's own KYC eligibility table.

## Durable aggregate

The repository reads the existing source-of-truth records in one account-scoped query:

- account status, protected contact email, membership date, and linked login methods from `account`
- local eligibility, declared country codes, proof-of-address state, and renewal dates from identity's own `KycEligibility` table, via the same shared `PrismaKycRepository` instance `/v1/kyc` itself reads through — a live read, not a local copy
- reservation and non-redeemed position counts from `money` and `settlement`
- wallet registration progress and distinct investment/payment/payout readiness from `settlement`, this same eligibility projection, and linked-login state

The response does not include raw wallet addresses, monetary balances, KYC evidence, provider payloads, session data, or notification preferences. It is customer-only, uses the authenticated account ID rather than a path parameter, and sends `Cache-Control: no-store`.

## Reservation history and current portfolio

Two customer-only, cursor-paginated subresources continue the profile aggregate without placing unbounded arrays on the overview response:

- `GET /v1/investor-profile/reservations?limit=20&after=...` returns reservation terms, lifecycle timestamps, a residential-property summary, and only the latest `money.money_events` capital-state projection. Provider names and provider references are excluded.
- `GET /v1/investor-profile/positions?limit=20&after=...` returns canonical off-chain holdings whose status is `pending_internal_settlement` or `active`. Redeemed positions and holder wallet addresses are excluded from this current-portfolio view. `reservation_id` and `offering_id` are `null` for a position that was not created from a reservation, such as one minted directly from an IPO escrow contribution (AD-256); `offering_id` is resolved only through the reservation.

Limits default to 20 and are capped at 100. Cursors include their resource kind, so cursors cannot be reused across the reservation and position endpoints. Reservations sort newest-first by creation time and ID. Positions sort active timestamps newest-first, with pending positions after activated positions.

## Verified display-name cache

Didit remains authoritative for identity names. VistaBlox does not persist them in PostgreSQL. `GetKycDisplayProfileService` (identity's own application service, called in-process — no gateway, no internal HTTP call) owns the whole cache. When both Didit and `PROFILE_CACHE_URL` are configured, an approved, correlated individual decision may populate a server-side Redis/Valkey entry containing exactly:

- `given_name`
- `family_name`
- `full_display_name`
- `didit_profile_last_synced_at`

Entries use the opaque key `kyc_display:{account_id}`, refresh after six hours, and expire after 24 hours. Configure the managed EU cache without routine backups. Unknown fields make an entry invalid and cause deletion. Starting a new baseline KYC session or receiving a correlated baseline KYC webhook invalidates the account's cached names — the API and the worker each hold their own connection to the same Redis instance so invalidation keeps working regardless of which process the triggering change came through (see [`didit-kyc.md`](didit-kyc.md)).

If Redis/Valkey is absent or unavailable, or a live Didit lookup fails, the endpoint continues to return the durable aggregate with `display_profile: null`. It does not bypass the required cache by turning Didit into a normal profile-read dependency. A transient Didit refresh failure may use an existing unexpired cache entry — but only when one exists; there is no other fallback.

## Response sections

The response includes `account_id`, account/contact metadata, optional `display_profile`, linked `login_methods`, the local `kyc` overview, investment counts, separate readiness flags, and wallet-registration status. `investment_eligible` requires an active account, current eligible KYC, and both Google and email/password recovery paths. A wallet request makes `payment_account_ready` true; confirmed registration makes `payout_account_verified` true. Dates are UTC ISO 8601 values. Proof-of-address state is projected as `expired` at read time when its stored current-until timestamp has elapsed.

## Wallet registration

`POST /v1/investor-profile/wallet` implements AD-241's wallet-provisioning flow: the mobile app generates a signing key locally, derives the Base-compatible public address, and sends only that address here. This endpoint requires current KYC eligibility (AD-241: "wallet provisioning is meant to happen right at KYC approval, before any reservation") and an active account; it does not require the broader `investment_eligible` composite, since linking recovery-capable login methods is a separate concern from being cleared to hold a wallet.

A server-generated, opaque `registration_commitment` (a `0x`-prefixed 32-byte hex value, usable directly as the `VistaBloxWalletRegistry.register(bytes32)` argument) is returned alongside the stored `wallet_address`, the `registry_contract_address` the mobile app should call `register()` on, `status` (`pending` until confirmed, `registered` once `registered_at` is set), and both timestamps. Addresses are stored and compared in lowercase; the repository trims and lowercases whatever it is given, and every lookup is `lower(wallet_address) = lower($1)` so rows written before that convention still match.

**A pending claim is not a binding.** A `wallet_registrations` row with `registered_at` NULL is only the address the customer typed: nothing has proved they control it. It is scoped to its own account, never blocks another account, and several accounts may hold a pending claim on the same address at once. The address is bound to one account only once the registry event confirms it, and the database enforces that through a partial unique index, `wallet_registrations_confirmed_address_key`, on `lower(wallet_address) WHERE registered_at IS NOT NULL`. So:

- Replaying the same `wallet_address` for the same account returns the existing row (same commitment, same `requested_at`), pending or registered.
- Submitting a *different* address while the account's own registration is still **pending** replaces the claim in place: the same row now holds the new address, a new `registration_commitment` and a new `requested_at`, and the response is `201` with `status` `pending` and the new commitment. The old commitment stops matching anything, so a registry event for it is reported as unmatched. The replacement is audited (`settlement.wallet_registration_replaced`, with the previous and the new address). A client that holds a pending row it cannot sign for (no local key) may therefore `POST` a new address instead of being stuck.
- Submitting a different address once the account's registration is **confirmed** is rejected (`409 wallet.registration_address_mismatch`): AD-241 treats creation and address change/recovery as separate code paths, and this endpoint only implements the former.
- An address already **confirmed** for a different account is rejected (`409 wallet.address_already_claimed`). That includes the replay of an account's own pending claim on an address another account has since confirmed: its commitment is dead, so it is not handed out again, and the account can replace it with another address. An address held by someone else's pending claim is not an obstacle.

A double submit is safe: concurrent first requests of one account serialise on that account's row (`INSERT ... ON CONFLICT (account_id) DO NOTHING` after a row lock) and the loser replays the winner's row instead of failing with a database error.

Escrow-mint attribution (`resolveAccountIdForWallet`) resolves **confirmed** registrations only, so an unproven claim can never be handed a contributor's position. A contributor whose registration is still pending makes the finalize run stop with `No registered account found` until the watcher or staff confirm it. Payout readiness and the holder address copied into `position_ledger` at offering finalization still read the row as it exists, pending or not; tightening those to confirmed rows is separate follow-up work.

If `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` isn't configured for this environment, the endpoint returns `503 wallet.on_chain_registration_unavailable` before touching anything else.

AD-241's on-chain half (steps 6–10) is now implemented: `VistaBloxWalletRegistry` (`contracts/contracts/VistaBloxWalletRegistry.sol`) is a deliberately stateless, permissionless contract — anyone may call `register(bytes32 commitment)` for their own address at any time, emitting `WalletRegistered(wallet, commitment, timestamp)`; there is no admin role and nobody can register on another address's behalf. The worker's `settlement.confirm_wallet_registrations` job (every minute) watches that event, matches each one back to the pending row that requested it by commitment, sanity-checks the on-chain sender against the stored address (logging a warning on mismatch — a possible spoofed registration attempt), and sets `registered_at`. That write is a compare-and-set on the exact claim that was matched (account, stored address and stored commitment, still pending): a claim the account replaced between the match and the write is ignored (reported as `staleConfirmations` in the job summary) rather than confirmed on the old address's evidence. If another account already holds the address confirmed, the database refuses the second confirmation; the job records `settlement.wallet_registration_confirmation_conflict` once per account and address (`confirmationConflicts` in the summary), leaves the losing claim pending, and carries on with the next event. Each confirmation writes `settlement.wallet_registration_confirmed`. This is scoped to Base Sepolia for now: `AD-234` still keeps *production* (mainnet) blockchain settlement dormant pending a written-counsel memo, but AD-234 explicitly permits exercising this layer on testnet, which is what `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` being independently configurable (separate from the rest of the `CHAIN_*` bundle) is for.

Staff can confirm a registration the watcher missed with `POST /internal/v1/wallet-accounts/:account_id/reconcile` (transaction hash in the body; the same `admin_operations` and staff-WebAuthn gate as the read). The chain evidence is verified against the address and commitment the row held when it was read, and the write is a compare-and-set on both: if the customer replaced the pending claim in the meantime the call answers `409 wallet.registration_changed` and writes nothing, so read the registration again and retry. If another account already holds the address confirmed it answers `409 wallet.address_already_claimed` and records the conflict in `audit_log` with the staff actor.

`GET /v1/investor-profile/wallet` reads this account's own `wallet_address`, `status`, and both timestamps back — deliberately separate from, and unconditionally available regardless of, `GET /v1/investor-profile`'s own documented exclusion of raw wallet addresses above: this is a wallet-specific subresource the customer explicitly navigates to, not the general profile aggregate, and the read itself is a plain `wallet_registrations` row lookup with no chain access at all, so it doesn't need `CHAIN_*` configured any more than `POST` does. `404 wallet.not_registered` if the account has no wallet on file yet. Mobile's wallet-recovery flow (restoring a device-local key from a backed-up seed phrase) is the first real caller: it needs the account's already-registered address to verify a freshly re-derived one against before trusting a restore.

`GET /v1/investor-profile/wallet/balance` is the on-chain-dependent sibling: capital (`capital_eurc`) and per-`PIV` token balances, read live from the chain. Only mounted when `wallet.balances` (the `CHAIN_*` bundle) is configured — unlike the status endpoint above, this one genuinely can't answer without live chain access.
