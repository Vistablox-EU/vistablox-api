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

AD-241's on-chain half (steps 6–10) is now implemented: `VistaBloxWalletRegistry` (`contracts/contracts/VistaBloxWalletRegistry.sol`) is a deliberately stateless, permissionless contract — anyone may call `register(bytes32 commitment)` for their own address at any time, emitting `WalletRegistered(wallet, commitment, timestamp)`; there is no admin role and nobody can register on another address's behalf. The worker's `settlement.confirm_wallet_registrations` job (every minute) watches that event, matches each one back to the pending row that requested it by commitment, sanity-checks the on-chain sender against the stored address (logging a warning on mismatch — a possible spoofed registration attempt), and sets `registered_at`. This is scoped to Base Sepolia for now: `AD-234` still keeps *production* (mainnet) blockchain settlement dormant pending a written-counsel memo, but AD-234 explicitly permits exercising this layer on testnet, which is what `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` being independently configurable (separate from the rest of the `CHAIN_*` bundle) is for.

`GET /v1/investor-profile/wallet` reads this account's own `wallet_address`, `status`, and both timestamps back — deliberately separate from, and unconditionally available regardless of, `GET /v1/investor-profile`'s own documented exclusion of raw wallet addresses above: this is a wallet-specific subresource the customer explicitly navigates to, not the general profile aggregate, and the read itself is a plain `wallet_registrations` row lookup with no chain access at all, so it doesn't need `CHAIN_*` configured any more than `POST` does. `404 wallet.not_registered` if the account has no wallet on file yet. Mobile's wallet-recovery flow (restoring a device-local key from a backed-up seed phrase) is the first real caller: it needs the account's already-registered address to verify a freshly re-derived one against before trusting a restore.

`GET /v1/investor-profile/wallet/balance` is the on-chain-dependent sibling: capital (`capital_eurc`) and per-`PIV` token balances, read live from the chain. Only mounted when `wallet.balances` (the `CHAIN_*` bundle) is configured — unlike the status endpoint above, this one genuinely can't answer without live chain access.

## Wallet transfers

`POST /v1/investor-profile/wallet/transfers` (body `piv_id`, `to_wallet_address`, `amount`) prepares a transfer of a held PIV token and returns the unsigned `safeTransferFrom` call for the investor's own device to sign and submit (AD-267, AD-240). The backend never holds a key, signs, or broadcasts. This is the only transfer surface: there is no separate preview call, so the response is both the preview and the prepared transfer, and the two cannot disagree.

The endpoint reads the chain head once (uncached) and pins everything else to that block's hash (EIP-1898, `requireCanonical`). One Multicall3 `eth_call` reads the sender's token balance, the recipient's `isHolderAuthorized` flag and `isTokenPaused`; a second `eth_call` simulates the exact calldata that is returned, from the investor's wallet, at the same block. A success carries that snapshot next to the unsigned transaction:

| `data.preflight` field | Meaning |
| --- | --- |
| `block_number`, `block_hash` | The block every read and the simulation came from (decimal string, lowercase `0x` hash) |
| `sender_balance` | The sender's token balance at that block (decimal string) |
| `recipient_authorized` | Always `true` on a 200 |
| `token_paused` | Always `false` on a 200 |
| `simulation` | Always `"passed"` on a 200: the calldata ran without reverting from the wallet at that block |

RPC provider requirement: `CHAIN_RPC_URL` must point to a provider that accepts an EIP-1898 block hash with `requireCanonical` in `eth_call`, and that answers a block it has just reported as head from every backend behind its load balancer. Support is not verified for the provider planned for production (CDP Node, `docs/plans/device-bound-auth-backend.md`, `docs/plans/devops-device-bound-auth.md`; neither plan records a check): make one `POST` against the staging deployment before relying on this route. A provider that rejects block hashes fails every request with `503 wallet.chain_unavailable`, and the server log then shows `ChainStateUnavailableError` with the node's JSON-RPC code (for example `-32602`, invalid params), which is how it is told apart from a timeout or a rate limit. Contingency, until the provider is switched: pin by `{ blockNumber: head.number }` in `readTransferSnapshot` instead of the block hash. Every node accepts that, but it cannot detect a reorg between the head read and the pinned calls.

The preflight is advisory. State can change after the block it describes, the contract remains the final authority, and the simulation covers only the inner `safeTransferFrom` call. It does not simulate an ERC-4337 UserOperation (bundler, paymaster, owner signature, gas). `Cache-Control: no-store` stays on the response.

When the preflight fails, nothing is prepared and the response is a documented error envelope:

| Status | Code | Meaning |
| --- | --- | --- |
| 404 | `wallet.not_registered` | The account has no registered wallet |
| 404 | `wallet.piv_not_held` | The account holds no minted position for the PIV |
| 422 | `wallet.transfer_lane_closed` | The contract's transfer lane is closed |
| 422 | `wallet.token_paused` | The token (or the whole contract) is paused |
| 422 | `wallet.recipient_not_authorized` | The recipient is not authorized to hold the token |
| 422 | `wallet.insufficient_balance` | The amount exceeds the sender's balance at the block |
| 422 | `wallet.recipient_cannot_receive` | The recipient address cannot receive the token |
| 422 | `wallet.transfer_would_revert` | The simulation reverted for a reason not listed above |
| 503 | `wallet.chain_unavailable` | The chain could not be read within the 10 second budget; retry |

When several reasons apply the first in this order wins: closed lane, paused, recipient not authorized, insufficient balance, recipient cannot receive, any other revert. The chain being unreachable was previously a 500; it is now a 503, and the response carries no RPC URL.

Reading the 503 in the server log: the logged error has the reason as its cause, for example `ChainStateUnavailableError: CallExecutionError: Invalid parameters were provided to the RPC method. (code -32602)`. That is viem's error class and fixed sentence plus the numeric JSON-RPC code or HTTP status, so a provider that rejects block-hash pinning (`-32602`), a header the node does not have (`-32000`), a rate limit (`-32005`, status `429`) and a timeout (`chain state read timed out`) can be told apart. It never holds the RPC URL, a key or the node's own message text, and it is never part of the response body.

A node that has not yet seen the head another backend just reported (or whose head was reorged away) answers "header not found", `-32001` or "not currently canonical" to the pinned calls. viem's transport does not retry those, so the whole snapshot is taken once more from a fresh head, inside the same 10 second budget. No other failure is retried. Which wordings count is a short list in `transfer-snapshot.ts` (`isPinnedBlockUnavailable`); a wording it misses is not retried and answers 503.

**Current behaviour: every request answers `422 wallet.transfer_lane_closed`.** The Phase 1 `VistaBloxProperty.safeTransferFrom` always reverts with `TransferLaneClosed` (`contracts/contracts/VistaBloxProperty.sol`), so any calldata this endpoint prepared before the simulation existed would have failed on chain. The endpoint now says so up front instead of handing out a doomed transaction. It starts returning 200 once a transfer lane is opened in the contract; whether and when that happens is a product and legal decision recorded outside this repository.

`GET /balance` is separate and unchanged: it still reads the capital and token balances with independent, unpinned calls, so its numbers can differ from the snapshot a later transfer response reports.
