# Coinbase CDP onramp

This is the buy-side (`EUR -> EURC`) REST surface that backs reservation funding (`AD-255`). It is a distinct Coinbase CDP capability from the on-device wallet-key tooling `AD-246` names — this client never touches signing key material, only the onramp/offramp REST API documented at `docs.cdp.coinbase.com/onramp`.

## Runtime flow

1. `CreateReservationService` creates the reservation row and its first `money.money_events` row inside one transaction (`AD-146`; see [`investor-offering.md`](investor-offering.md#reservation-creation)).
2. It then calls `POST /onramp/v1/token` with the investor's already-registered wallet address, synchronously in the request path, and records `eurc_purchase_pending`.
3. The response is turned into a hosted purchase URL (`https://pay.coinbase.com/buy/select-asset?sessionToken=...&partnerUserRef=...&redirectUrl=...`) and returned to the client. The investor picks their own payment method inside Coinbase's hosted UI — VistaBlox never collects or stores one, which is load-bearing for `AD-254`'s non-custody position (the purchase must be investor-initiated, not something VistaBlox performs on their behalf).
4. `partnerUserRef` is the reservation ID, not the account ID, so a later `GET /onramp/v1/buy/user/{partnerUserRef}/transactions` call resolves unambiguously to one reservation even if an account has reserved more than once over time.

There is no onramp/offramp webhook (confirmed against CDP's own API reference, not assumed — the only "Webhooks" product CDP documents is an unrelated on-chain contract-event feature). Advancing `capital_state` past `eurc_purchase_pending` requires polling step 4's endpoint on a schedule: `case_timers.reservation_onramp_poll` (`PollOnrampTransactionsService`, run every minute by the worker process) does this, and is the only worker job so far that the worker skips registering entirely when its provider credentials aren't configured — every other scheduled job's dependencies are always present. See [`investor-offering.md`](investor-offering.md#advancing-capital_state-the-onramp-transaction-poll) for the exact success/failed/still-pending resolution rule and the one race this pass deliberately leaves unresolved.

## Authentication

Every request carries a short-lived (120s) JWT bearer token, generated per request and verified directly against `@coinbase/cdp-sdk`'s own `auth/utils/jwt.ts` rather than assumed: EdDSA (a 64-byte base64 Ed25519 secret) or ES256 (a PEM EC private key) auto-detected from the configured secret's shape, header `{alg, kid: <key ID>, typ: "JWT", nonce}`, claims `{sub: <key ID>, iss: "cdp", aud: ["cdp_service"], uris: ["METHOD host/path"]}`. VistaBlox signs this itself with `jose` (already a transitive dependency via `better-auth`) rather than depending on the full `@coinbase/cdp-sdk` package, which pulls in an unrelated Solana/viem/axios dependency tree for the ~30 lines this actually needs.

## Configuration

Configure all three of these together, or leave all three empty to disable reservation funding (the funding rail then stays reported as `funding_rail_unavailable` regardless):

- `COINBASE_CDP_API_KEY_ID`
- `COINBASE_CDP_API_KEY_SECRET`
- `COINBASE_ONRAMP_REDIRECT_URL`

`COINBASE_CDP_API_BASE_URL` defaults to `https://api.developer.coinbase.com`. `COINBASE_CDP_PAY_HOSTED_URL` defaults to `https://pay.coinbase.com/buy/select-asset`. `COINBASE_ONRAMP_BLOCKCHAIN` defaults to `base`.

## Data boundary

`listBuyTransactions` normalizes Coinbase's `OnrampTransaction` response down to what `capital_state` advancement actually needs (transaction ID, status, wallet address, purchase/payment amounts, tx hash, timestamps); fields like `user_id` and `end_partner_name` are read by nothing in this codebase and are dropped rather than persisted or logged.
