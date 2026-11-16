# Coinbase CDP onramp

This is the buy-side (`EUR -> EURC`) REST surface that backs reservation funding (`AD-255`). It is a distinct Coinbase CDP capability from the on-device wallet-key tooling `AD-246` names — this client never touches signing key material, only the onramp/offramp REST API documented at `docs.cdp.coinbase.com/onramp`.

## Runtime flow

1. `CreateReservationService` creates the reservation row and its first `money.money_events` row inside one transaction (`AD-146`; see [`investor-offering.md`](investor-offering.md#reservation-creation)).
2. It then calls `POST /onramp/v1/token` with the investor's already-registered wallet address (stored lowercase; the client sends Coinbase its EIP-55 checksum spelling, and passes anything that is not a valid address through unchanged), synchronously in the request path, and records `eurc_purchase_pending`.
3. The response is turned into a hosted purchase URL (`https://pay.coinbase.com/buy/select-asset?sessionToken=...&partnerUserRef=...&redirectUrl=...`) and returned to the client. The investor picks their own payment method inside Coinbase's hosted UI — VistaBlox never collects or stores one, which is load-bearing for `AD-254`'s non-custody position (the purchase must be investor-initiated, not something VistaBlox performs on their behalf).
4. `partnerUserRef` is the reservation ID, not the account ID, so a later `GET /onramp/v1/buy/user/{partnerUserRef}/transactions` call resolves unambiguously to one reservation even if an account has reserved more than once over time.

Advancing `capital_state` past `eurc_purchase_pending` has two triggers that share one code path:

- **Webhook (fast path).** CDP sends signed onramp transaction events (`onramp.transaction.created`, `.updated`, `.success`, `.failed`) to `POST /webhooks/coinbase-onramp` (see [Webhook](#webhook) below). The API verifies the signature and enqueues a `provider_events.coinbase_onramp_webhook` job carrying only the reservation ID, the event ID and the event type; the worker then re-runs the poll's own reconciliation for that one reservation.
- **Poll (backstop).** `case_timers.reservation_onramp_poll` (`PollOnrampTransactionsService`, run every minute by the worker process) still lists every reservation awaiting its purchase and calls step 4's endpoint for each. It catches anything the webhook missed: a delivery that never arrived, a subscription that isn't configured, or an event that reached us before CDP's Transaction Status API reflected it. It is the only worker job so far that the worker skips registering entirely when its provider credentials aren't configured; every other scheduled job's dependencies are always present.

Both triggers call `PollOnrampTransactionsService.reconcileReservation`, so they resolve the outcome identically, and both record through `recordOnrampMoneyEventOnce`. That method locks the reservation row (`FOR UPDATE`), re-checks inside the lock that the stage is still `initiated` and the latest `capital_state` is still `eurc_purchase_pending` or `purchase_failed`, and skips the write when the latest event already has the same provider transaction and `capital_state`. A duplicate webhook delivery, a webhook racing the minute poll, and a late `failed` after a recorded success therefore write nothing. See [`investor-offering.md`](investor-offering.md#advancing-capital_state-the-onramp-transaction-poll) for the exact success/failed/still-pending resolution rule and the one race this pass deliberately leaves unresolved.

## Authentication

Every request carries a short-lived (120s) JWT bearer token, generated per request and verified directly against `@coinbase/cdp-sdk`'s own `auth/utils/jwt.ts` rather than assumed: EdDSA (a 64-byte base64 Ed25519 secret) or ES256 (a PEM EC private key) auto-detected from the configured secret's shape, header `{alg, kid: <key ID>, typ: "JWT", nonce}`, claims `{sub: <key ID>, iss: "cdp", aud: ["cdp_service"], uris: ["METHOD host/path"]}`. VistaBlox signs this itself with `jose` (already a transitive dependency via `better-auth`) rather than depending on the full `@coinbase/cdp-sdk` package, which pulls in an unrelated Solana/viem/axios dependency tree for the ~30 lines this actually needs.

## Configuration

Configure all three of these together, or leave all three empty to disable reservation funding (the funding rail then stays reported as `funding_rail_unavailable` regardless):

- `COINBASE_CDP_API_KEY_ID`
- `COINBASE_CDP_API_KEY_SECRET`
- `COINBASE_ONRAMP_REDIRECT_URL`

`COINBASE_ONRAMP_WEBHOOK_SECRET` is optional and separate: it enables the webhook route (see below). Leave it empty and the route is not mounted at all (requests get `404`), while the minute poll keeps working on its own. It requires `COINBASE_CDP_API_KEY_ID`, since the webhook only triggers a CDP re-fetch.

`COINBASE_CDP_API_BASE_URL` defaults to `https://api.developer.coinbase.com`. `COINBASE_CDP_PAY_HOSTED_URL` defaults to `https://pay.coinbase.com/buy/select-asset`. `COINBASE_ONRAMP_BLOCKCHAIN` defaults to `base`.

## Webhook

Source: CDP's onramp webhook and webhook signature-verification documentation on `docs.cdp.coinbase.com`, checked when this was built.

**Subscribing.** Create one subscription per environment with the CDP CLI, pointing at `https://<api-host>/webhooks/coinbase-onramp` and listing the four `onramp.transaction.*` event types (`cdp data webhooks subscriptions create`). The response's `metadata.secret` is the value for `COINBASE_ONRAMP_WEBHOOK_SECRET`. The API must also have the CDP client configured; without it the route stays unmounted even when the secret is set. On staging, `docker-compose.staging.yml`'s `&app-environment` anchor must pass the variable through before it reaches the container.

**Verification** (`CoinbaseOnrampWebhookVerifier`):

- The route is mounted with `express.raw()` ahead of the app-wide JSON parser, so the HMAC is computed over the exact bytes CDP sent (capped at 256 KB).
- The signature header is `X-Webhook-Signature: t=<unix seconds>,v0=<hex>,...` (`X-Hook0-Signature` is accepted as CDP's deprecated name for the same value). Only `v0` is checked: `HMAC-SHA256(secret, "<t>.<raw body>")`, compared in constant time. Any other scheme in the header is ignored.
- `t` must be within 5 minutes of the server clock, in either direction, which is CDP's recommended maximum age and bounds replay of a captured delivery.
- A missing, malformed, stale or mismatched signature gets `401` with code `offering.coinbase_webhook_invalid`. A signed body that is not JSON, or has no `eventType`, gets `400` with `offering.coinbase_webhook_payload_invalid`.

**What the body is trusted for.** Only `eventType` and `partnerUserRef` are read. Status, amounts, wallet address and the user's country are never taken from the body: the worker re-fetches the reservation's transactions from CDP, exactly as the poll does. A verified event is acknowledged with `200 {"received": true}` but not enqueued when it is not an `onramp.transaction.*` event or its `partnerUserRef` is not shaped like a reservation ID. Neither the body nor any PII in it (`walletAddress`, `country`, `userId`) is logged or stored in the job payload.

**Processing.** `ReceiveCoinbaseOnrampWebhookService` enqueues `provider_events.coinbase_onramp_webhook` (event-job retry profile, dead-lettered after its last retry). Every delivery is enqueued, duplicates included; idempotency is enforced where the money event is recorded, not by an event-ID inbox. The worker's `ReconcileOnrampWebhookService` loads the reservation only if it is still awaiting its purchase, then calls `reconcileReservation`. Its log line reports `ignored` (no longer awaiting a purchase), `recorded`, or `unchanged` (still in flight at CDP, or this outcome was already recorded). The consumer is registered only when the worker has a CDP client; the queue itself is always created, so a send never fails against a missing queue.

## Data boundary

`listBuyTransactions` normalizes Coinbase's `OnrampTransaction` response down to what `capital_state` advancement actually needs (transaction ID, status, wallet address, purchase/payment amounts, tx hash, timestamps); fields like `user_id` and `end_partner_name` are read by nothing in this codebase and are dropped rather than persisted or logged.

## Errors and operator alerts

The client classifies every CDP failure by HTTP status and never reads or logs the response body.

| Upstream result | API error | Retry? | Operator signal |
| --- | --- | --- | --- |
| 5xx, 429, 408, network failure, timeout | `offering.coinbase_provider_unavailable` (503) | Yes, with backoff | None (transient) |
| 401, 403 | `offering.coinbase_provider_auth_rejected` (500) | No | `event: coinbase_cdp.auth_rejected`, `severity: error` |
| Any other 4xx | `offering.coinbase_provider_request_rejected` (422) | No, not unchanged | `event: coinbase_cdp.request_rejected`, `severity: warn` |
| Unusable `COINBASE_CDP_API_KEY_SECRET` (no request sent) | `offering.coinbase_provider_key_invalid` (500) | No | `event: coinbase_cdp.key_invalid`, `severity: error` |

Alert lines follow the wallet-registry convention: a structured pino line with a stable dotted `event`, a `severity` (`error` pages, `warn` opens a ticket), and snake_case fields (`operation`, `http_status`). Alert rules key on `event` and `severity`, never on the message text. A 401/403 or invalid key means the API key is wrong, revoked, or lacks permissions; retrying will not help until the configuration is fixed.
