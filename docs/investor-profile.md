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

A server-generated, opaque `registration_commitment` (a `0x`-prefixed 32-byte hex value, usable directly as the `VistaBloxWalletRegistry.register(bytes32)` argument) is returned alongside the stored `wallet_address`, the `registry_contract_address` the mobile app should call `register()` on, `status` (`pending` until confirmed, `registered` once `registered_at` is set), and both timestamps. Creation is idempotent by account: replaying the same `wallet_address` for an account that already has it registered returns the existing row rather than erroring. Submitting a *different* address for an account that already has one is rejected (`409 wallet.registration_address_mismatch`) — AD-241 treats creation and address change/recovery as separate code paths, and this endpoint only implements the former. An address already claimed by a different account is also rejected (`409 wallet.address_already_claimed`); `settlement.wallet_registrations.wallet_address` carries the same uniqueness as a database constraint. If `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` isn't configured for this environment, the endpoint returns `503 wallet.on_chain_registration_unavailable` before touching anything else.

Both `wallet_address` here and `to_wallet_address` on `POST /v1/investor-profile/wallet/transfers` must be 20-byte hex addresses and must not be the all-zero address (`0x` followed by forty zeros). The zero address cannot send the `register()` transaction, so a registration under it could never confirm, and it names no holder as a transfer destination. It is rejected at request validation as `422 validation.invalid_field` (`field_errors[0]`: `field` = `wallet_address` or `to_wallet_address`, `code` = `custom`, `message` = `Must not be the zero address`) before the registry-configuration check, KYC, the repository or any chain read. No other address is screened: a burn address such as `0x...dEaD` passes the shape check.

AD-241's on-chain half (steps 6–10) is now implemented: `VistaBloxWalletRegistry` (`contracts/contracts/VistaBloxWalletRegistry.sol`) is a deliberately stateless, permissionless contract — anyone may call `register(bytes32 commitment)` for their own address at any time, emitting `WalletRegistered(wallet, commitment, timestamp)`; there is no admin role and nobody can register on another address's behalf. The worker's `settlement.confirm_wallet_registrations` job (every minute) watches that event, matches each one back to the row that requested it by commitment, sanity-checks the on-chain sender against the stored address (logging a warning on mismatch — a possible spoofed registration attempt), and sets `registered_at` together with the identity of the confirming event (see below). This is scoped to Base Sepolia for now: `AD-234` still keeps *production* (mainnet) blockchain settlement dormant pending a written-counsel memo, but AD-234 explicitly permits exercising this layer on testnet, which is what `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` being independently configurable (separate from the rest of the `CHAIN_*` bundle) is for.

`GET /v1/investor-profile/wallet` reads this account's own `wallet_address`, `status`, and both timestamps back — deliberately separate from, and unconditionally available regardless of, `GET /v1/investor-profile`'s own documented exclusion of raw wallet addresses above: this is a wallet-specific subresource the customer explicitly navigates to, not the general profile aggregate, and the read itself is a plain `wallet_registrations` row lookup with no chain access at all, so it doesn't need `CHAIN_*` configured any more than `POST` does. `404 wallet.not_registered` if the account has no wallet on file yet. Mobile's wallet-recovery flow (restoring a device-local key from a backed-up seed phrase) is the first real caller: it needs the account's already-registered address to verify a freshly re-derived one against before trusting a restore.

`GET /v1/investor-profile/wallet/balance` is the on-chain-dependent sibling: capital (`capital_eurc`) and per-`PIV` token balances, read live from the chain. Only mounted when `wallet.balances` (the `CHAIN_*` bundle) is configured — unlike the status endpoint above, this one genuinely can't answer without live chain access.

### Chain evidence

The confirmation and the evidence for it are written in one statement (`UPDATE ... WHERE registered_at IS NULL`), so a registration is never confirmed without the event that confirmed it, and a replay of the same event finds the row already registered and changes nothing. The stored identity is the transaction hash, block hash, block number and log index of the `WalletRegistered` log (hashes lower case). The event is identified by **(transaction hash, log index)**, not by the transaction hash alone: the registry is stateless and permissionless, and a bundler (AD-271) can relay several registrations in one transaction. `uq_wallet_registrations_chain_event` makes that pair unique, so one on-chain event backs at most one registration. An event the node reports without a complete identity (a removed log, a log without a block hash, block number or log index) is counted in `eventsWithoutIdentity` and never confirms a row.

What the job does with an event for a row that is already registered:

- the same event again (the 32-block rescan overlap, a retry after a crash): counted as `eventsReplayed`, nothing written;
- a row confirmed before evidence was kept, or with a transaction hash and block number only: the evidence is recorded (`evidenceRecorded`), `registered_at` is untouched;
- the same transaction mined again in another block: the evidence is replaced (`evidenceRefreshed`); a flagged row whose event is on the chain again is refreshed the same way, which clears the flag;
- a different transaction or a second matching log for a confirmed row, or an event emitted for another wallet: counted in `conflictingEvents`, nothing written.

After the events, the job compares the block recorded for each confirmation with the chain (up to 50 rows per run, oldest block first; `evidenceRechecked`). A block that is still canonical and at least 900 blocks (about 30 minutes) deep is marked verified and is not looked at again. If the block at that height changed, the job looks up the transaction: mined again elsewhere means the evidence is refreshed; a missing transaction, a reverted one or a receipt without the event means the row is **flagged** (`transaction_missing`, `transaction_reverted`, `event_missing`). **`registered_at` is never reverted.** The registry holds no state and a registration only proves control of the wallet, so an orphaned event does not undo that proof, and releasing the registration would let the same address be claimed twice (AD-241). A flag is information for staff, and the wallet stays usable until staff decide otherwise. Whenever a confirmation is refreshed or flagged and its block is less than 900 blocks old, the cursor is moved back to just before that block (`cursorRewoundTo`) so the next run re-reads the blocks around it; a deeper mismatch is flagged without rewinding. A node that does not have the block, or that contradicts itself, gives no verdict: it is counted in `evidenceRecheckErrors` and nothing is flagged.

Not covered: a reorganization that touches no confirmed registration can hide the event of a registration that is still pending, if it falls outside the 32-block overlap. Detecting that needs the hash of the last processed block stored with the cursor.

`GET /internal/v1/wallet-accounts/:account_id` (staff) shows the evidence as `registration_evidence`: `status` (`none`, `partial` for a transaction hash and block number only, `recorded`, `verified`, `flagged`), the identity, `verified_at`, and the `flag` with `flagged_at`. Customer endpoints never expose it.

`POST /internal/v1/wallet-accounts/:account_id/reconcile` (staff, WebAuthn) records the same evidence for a registration whose event the job missed or got wrong. It verifies the transaction on the chain (at least 3 confirmations; the first `WalletRegistered` log in it for this wallet and commitment), then, under a row lock: confirms a pending registration (`outcome: confirmed`), fills in missing evidence (`evidence_recorded`), replaces the evidence of a flagged registration or of one whose transaction was mined again (`evidence_replaced`), or reports `unchanged`. `registered_at` is only written for a pending row. Failures: `422 wallet.registration_transaction_not_found`, `wallet.registration_transaction_reverted`, `wallet.registration_event_not_found`; `409 wallet.registration_transaction_unconfirmed` (retry), `wallet.registration_evidence_conflict` (the registration is confirmed by a different event and not flagged; nothing changed), `wallet.registration_event_already_used` (the event backs another account); `503 wallet.chain_unavailable`, `wallet.reconciliation_unavailable`. Its audit row (`settlement.wallet_registration_reconciled`, `..._evidence_recorded`, `..._evidence_replaced`) is stamped with the time of the call; the chain time stays in `changes.registered_at`.
