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

`document_ref` is the canonical document reference stored by the offering domain. A download/presigning adapter is not yet implemented, so callers must not assume the value is a public URL.

## Why reservation creation is closed

As checked on 2026-09-01, Stripe's current Onramp destination-network table does not list EURC as a supported destination asset. It also states that USDC on Base is not supported in the EU. That conflicts with the documented VistaBlox phase-1 requirement for an investor-initiated EUR-to-EURC purchase on Base. Stripe also labels the Onramp API as a public-preview product requiring access approval.

Authoritative references:

- [Stripe Crypto Onramp supported networks and currencies](https://docs.stripe.com/crypto/onramp)
- [Stripe embedded Onramp integration](https://docs.stripe.com/crypto/onramp/embedded?locale=en-GB)
- [Stripe Onramp Sessions API](https://docs.stripe.com/api/crypto/onramp_sessions?lang=go)

The API therefore returns `funding_rail_unavailable` and does not create a reservation. It also returns `disclosure_pack_unavailable` when no non-empty current pack exists. Silently substituting USDC, another network, or another provider would alter the financial and legal architecture. Creating the reservation before the rail exists would consume hard offering capacity, while the current design has no expiry/release rule for an unfunded `initiated` or `eurc_purchase_pending` hold.

Before enabling reservation writes, the architecture needs both:

1. a supported and approved funding rail whose asset/network combination matches the legally selected flow; and
2. explicit timeout, retry, cancellation, and capacity-release rules for abandoned and failed purchases.

Once those decisions exist, the existing readiness projection can open without changing the response contract, and the reservation write can be added behind the shared idempotency middleware and an atomic capacity check.
