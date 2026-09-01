# Investor profile

`GET /v1/investor-profile` returns the authenticated customer's consolidated profile. It implements the documented cross-reference and deliberately does not introduce an `investor_profile` table.

## Durable aggregate

The repository reads the existing source-of-truth records in one account-scoped query:

- account status, protected contact email, membership date, and linked login methods from `account`
- local eligibility, declared country codes, proof-of-address state, and renewal dates from `identity`
- reservation and non-redeemed position counts from `money` and `settlement`
- wallet registration progress and distinct investment/payment/payout readiness from `settlement`, `identity`, and linked-login state

The response does not include raw wallet addresses, monetary balances, KYC evidence, provider payloads, session data, or notification preferences. It is customer-only, uses the authenticated account ID rather than a path parameter, and sends `Cache-Control: no-store`.

## Verified display-name cache

Didit remains authoritative for identity names. VistaBlox does not persist them in PostgreSQL. When both Didit and `PROFILE_CACHE_URL` are configured, an approved, correlated individual decision may populate a server-side Redis/Valkey entry containing exactly:

- `given_name`
- `family_name`
- `full_display_name`
- `didit_profile_last_synced_at`

Entries use the opaque key `kyc_display:{account_id}`, refresh after six hours, and expire after 24 hours. Configure the managed EU cache without routine backups. Unknown fields make an entry invalid and cause deletion. Starting a new baseline KYC session or receiving a correlated baseline KYC webhook invalidates the account's cached names.

If Redis/Valkey is absent or unavailable, the endpoint continues to return the durable aggregate with `display_profile: null`. It does not bypass the required cache by turning Didit into a normal profile-read dependency. A transient Didit refresh failure may use an existing unexpired cache entry.

## Response sections

The response includes `account_id`, account/contact metadata, optional `display_profile`, linked `login_methods`, the local `kyc` overview, investment counts, separate readiness flags, and wallet-registration status. `investment_eligible` requires an active account, current eligible KYC, and both Google and email/password recovery paths. A wallet request makes `payment_account_ready` true; confirmed registration makes `payout_account_verified` true. Dates are UTC ISO 8601 values. Proof-of-address state is projected as `expired` at read time when its stored current-until timestamp has elapsed.
