# Customer authentication routes

Valid for main at 48aa967 (2026-11-18).

This reference lists every `/v1/auth/*` route that serves customers and their devices, plus `GET /v1/app/config`: device enrolment and login, device replacement, session management, login-method unlinking, account closure and the signing-request routes. It is read by the mobile developers who call them and by engineers who change them. The concepts behind the routes (DPoP proofs, challenges, attestation, session levels, fresh authentication) are in [../authentication.md](../authentication.md); the Better Auth routes under `/api/auth/*` are in [better-auth.md](better-auth.md); the staff routes under `/internal/v1/auth/*` and the staff invitation route are in [auth-staff.md](auth-staff.md).

## Routes

| Method and path | Auth | Purpose |
| --- | --- | --- |
| [`GET /v1/app/config`](#get-v1appconfig) | DPoP proof only | Feature flags, minimum app versions, supported platforms, deployment identity (C1) |
| [`POST /v1/auth/mobile/enrol/challenge`](#post-v1authmobileenrolchallenge) | DPoP proof only | Issue the single-use enrolment challenge (E1) |
| [`POST /v1/auth/mobile/enrol/verify`](#post-v1authmobileenrolverify) | Pending session and DPoP proof | Enrol the device and create the device session (E2) |
| [`POST /v1/auth/mobile/login/challenge`](#post-v1authmobileloginchallenge) | DPoP proof only | Issue the single-use login challenge (L1) |
| [`POST /v1/auth/mobile/login/verify`](#post-v1authmobileloginverify) | DPoP proof and device signature | Log in with the device key and create the device session (L2) |
| [`POST /v1/auth/mobile/replacement/request`](#post-v1authmobilereplacementrequest) | Session | Email a device-replacement code |
| [`POST /v1/auth/mobile/replacement/verify`](#post-v1authmobilereplacementverify) | Session | Spend the code, revoke the active device |
| [`GET /v1/auth/sessions`](#get-v1authsessions) | Session | List the caller's sessions |
| [`POST /v1/auth/sessions/revoke-all`](#post-v1authsessionsrevoke-all) | Session, fresh | End every session of the caller, the current one included |
| [`POST /v1/auth/sessions/:session_id/revoke`](#post-v1authsessionssession_idrevoke) | Session, fresh | End one session |
| [`POST /v1/auth/sessions/devices/:jkt/revoke`](#post-v1authsessionsdevicesjktrevoke) | Session, fresh | End the caller's sessions bound to one DPoP key |
| [`POST /v1/auth/login-methods/:method_type/unlink`](#post-v1authlogin-methodsmethod_typeunlink) | Session, fresh | Unlink Google or Apple |
| [`POST /v1/auth/account-closure`](#post-v1authaccount-closure) | Session, customer | Ask to close the account |
| [`POST /v1/auth/account-closure/cancel`](#post-v1authaccount-closurecancel) | Session, customer | Withdraw the pending closure request |
| [`GET /v1/auth/signing-requests`](#get-v1authsigning-requests) | Session | List signing requests (not mounted) |
| [`GET /v1/auth/signing-requests/:request_id`](#get-v1authsigning-requestsrequest_id) | Session | Read one signing request (not mounted) |
| [`POST /v1/auth/signing-requests/:request_id/challenge`](#post-v1authsigning-requestsrequest_idchallenge) | Session, device-bound | Issue a signing challenge (not mounted) |
| [`POST /v1/auth/signing-requests/:request_id/sign`](#post-v1authsigning-requestsrequest_idsign) | Session, device-bound | Submit the device signature (not mounted) |

"Session" means `requireAuthentication` (below). "Fresh" means `requireFreshAuthentication` after it. "Customer" means the handler refuses any other population. A route that does not name a population runs for a staff session as well, because `requireAuthentication` does not check the population.

## How these routes behave

### Authentication building blocks

| Name | What runs | Source |
| --- | --- | --- |
| Session | `requireAuthentication`: resolve the session (only `device_biometric` or `staff_passkey` is accepted), check the DPoP proof of a bound session, load the account and require `active`, set `authContext`, apply the baseline limiter, record activity | (`src/modules/auth/api/shared/require-authentication.ts:39-129`) |
| Fresh | `requireFreshAuthentication`: the session is a `device_biometric` session created within the last 5 minutes; a staff session goes to a repository check that only a staff passkey login satisfies | (`src/modules/auth/api/customer/require-fresh-authentication.ts:36-49`) |
| DPoP proof only | `requireDpopOnly`: verifies the `DPoP` header (no `ath` check; the `Authorization` header is ignored), records `(jkt, jti)` in `auth.dpop_replays`, sets `response.locals.dpopJkt` | (`src/modules/auth/api/customer/require-dpop-only.ts:51-96`) |
| DPoP proof, no record | `requireDpopOnlyForVerify`: the same without the replay record, because the ceremony records the proof itself | (`src/app.ts:769-772`) |
| Tight limiters | The IP limiter (10 per 60 s) and the DPoP-key limiter (10 per 60 s), both after the proof check; they exist only when a rate-limit store was configured at boot | (`src/app.ts:471-478`) |

> Pending #237: `createApp` is split into per-module compose functions under `src/composition`; the mounts do not change, but the `src/app.ts` line numbers cited in this file move.

A bound session must send `Authorization: Bearer <token>` and a fresh `DPoP` proof. The proof's `htu` is `BETTER_AUTH_URL` plus the request path (the query string is dropped), its `htm` is the method, and its `ath` is the base64url SHA-256 of the bearer token (`src/modules/auth/application/shared/dpop-proof-verifier.ts:102-111`). The proof rules are in [../authentication.md](../authentication.md#dpop-proofs).

Requests are JSON. `express.json` parses only bodies whose `Content-Type` is `application/json`, with a limit of 1 MB, and it runs before every `/v1` router (`src/app.ts:588`). A body sent with another content type is not parsed, so a route that needs a body answers `422 validation.invalid_field`.

### Common errors

Every route in this file can answer these. The entries below do not repeat them.

| Status | Code | Condition |
| --- | --- | --- |
| 400 | `request.invalid_json` | The body is not parseable JSON |
| 400 | `request.aborted`, `request.size_mismatch` | The body was cut short or does not match `Content-Length` |
| 413 | `request.payload_too_large` | The body is larger than 1 MB |
| 415 | `request.unsupported_charset`, `request.unsupported_encoding` | The charset is not UTF-8 or the `Content-Encoding` is unsupported |
| 4xx | `request.body_rejected` | Another body-parser client error, for example a body that fails to decompress; the status is the parser's own (`src/shared/http/body-parser-error.ts:102-112`) |
| 422 | `validation.invalid_field` | A path, query or body field fails its Zod schema; `field_errors` lists `field`, `code` and `message` for each issue |
| 404 | `resource.not_found` | No route matches, including a route that is not mounted |
| 500 | `internal.unexpected` | Any other exception |

The envelope is `{ type, code, title, status, detail, trace_id, field_errors? }` (`src/shared/http/error-handler.ts:17-25`). The body-parser codes are defined in `src/shared/http/body-parser-error.ts:21-76`. A request that sends an `x-trace-id` header gets that value back as `trace_id` and in the `x-trace-id` response header; without one the server generates `req_` plus a ULID (`src/shared/http/request-context.ts:9-14`).

A success body is parsed with its response schema before it is sent. A body that fails the parse throws a ZodError, which the error handler answers as `422 validation.invalid_field` (`src/shared/http/error-handler.ts:51-64`). On E2 and L2 the parse sits inside the `try` whose `catch` maps any other error to `500 internal.unexpected` (`src/modules/auth/api/customer/device-auth.router.ts:287-308`).

> Pending #245: a success body that fails its response schema answers `500 internal.response_invalid` with a fixed detail and no `field_errors`, on every route in this file that sends JSON; on main it answers 422, or 500 `internal.unexpected` on E2 and L2.

Routes that run `requireAuthentication` can also answer:

| Status | Code | Condition |
| --- | --- | --- |
| 401 | `authentication.required` | No session, or a session whose level is not accepted (an `oauth_pending` session, an expired session that is not a device session, a user with `disabledAt` or `recoveryRequiredAt` set) |
| 401 | `REAUTH_REQUIRED` | A `device_biometric` session reached its idle or absolute limit. The wire contract says to run L1 and L2, then repeat the request once (`docs/plans/device-bound-auth-backend.md:276`) |
| 401 | `DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID`, `DPOP_REPLAY`, `DPOP_KEY_MISMATCH` | The session is bound and the proof is absent, invalid, a replay, or made with another key. The response carries `WWW-Authenticate: DPoP error="invalid_dpop_proof"`. An unbound session created at or after `DPOP_PHASE1_CUTOVER_AT` that presents a valid proof also answers `DPOP_KEY_MISMATCH` |
| 403 | `account.restricted` | The account status is not `active` |
| 500 | `account.mapping_missing` | The session's user has no local account |
| 429 | `rate_limit.exceeded` | The baseline limiter (300 per 60 s per account) refused; the response carries `Retry-After: 60`. Only when a rate-limit store was configured |

The `401`, `403` and `500` rows are raised at `src/modules/auth/api/shared/require-authentication.ts:47-86`; the `429` row at `src/shared/http/rate-limit.ts:40-51`. Where `REAUTH_REQUIRED` is raised is in [../authentication.md](../authentication.md#sessions).

Routes that run `requireFreshAuthentication` can also answer `403 authentication.fresh_auth_required` (detail "Sign in again on this device before continuing.") (`src/shared/errors/fresh-authentication-required-error.ts:11`).

Routes that run `requireDpopOnly` or its no-record variant can answer `401 DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID` or `DPOP_REPLAY`, with the same `WWW-Authenticate` header (`src/modules/auth/api/customer/require-dpop-only.ts:82`). The middleware itself never answers `DPOP_KEY_MISMATCH`; E2 can, from the plugin check that follows it (see the E2 table).

The device-ceremony and signing codes (`DEVICE_*`, `DPOP_*`, `ATTESTATION_*`, `TX_*`, `REQUEST_*`, `SIGNING_REQUEST_NOT_FOUND`, `MOBILE_PLATFORM_NOT_SUPPORTED`, `ACCOUNT_RESTRICTED`, `REAUTH_REQUIRED`) are capitals with underscores because they follow the wire contract. The device router passes the code of a Better Auth `APIError` through unchanged (`src/modules/auth/api/customer/device-auth.router.ts:287-308`); the other codes in this file are lower case with dots, for example `authentication.required`.

### Idempotency and caching

None of these routes uses the `Idempotency-Key` middleware. `GET /v1/auth/sessions` and the device-revoke route answer `Cache-Control: no-store`.

## App configuration and device ceremonies

These five routes sit in front of the session. C1 and E1 and L1 take only a DPoP proof; E2 takes a pending session and a proof; L2 takes a proof and the device signature. The order of a customer's first run is: sign in with Google or Apple (`/api/auth/sign-in/social`, see [better-auth.md](better-auth.md)), E1, E2; every later run is L1, L2. The flow, the challenge rules, the device JWS and the attestation policy are in [../authentication.md](../authentication.md#device-bound-login).

All five are mounted on one condition and share two properties. They are mounted when `protectedApi.deviceAuth` is set, which `server.ts` does unconditionally (`src/server.ts:639`), and `createApp` throws at start when `protectedApi.dpop` is missing (`src/app.ts:753`). E1, E2, L1 and L2 sit behind the tight IP limiter and the DPoP-key limiter, after the proof check; C1 sits behind neither (`src/app.ts:777-789`).

### GET /v1/app/config

**Auth.** A DPoP proof, no session. The `Authorization` header is ignored.

**Mounted when.** Always on main (see above). The router answers `GET /config` under `/v1/app`; any other method or path under `/v1/app` is `404 resource.not_found` (`src/modules/auth/api/customer/device-auth.router.ts:103`).

**Request.** No body, no query. Header `DPoP: <proof>` whose `htu` is `<BETTER_AUTH_URL>/v1/app/config` and `htm` is `GET`.

**Success.** `200`.

| Field | Type | Value on main |
| --- | --- | --- |
| `data.min_app_version.ios`, `.android` | string | `"0.0.0"` for both |
| `data.features.device_auth` | boolean | `true` |
| `data.features.device_enrolment_required` | boolean | `false` |
| `data.features.signing_requests` | boolean | `false` |
| `data.features.recovery_v2` | boolean | `false` |
| `data.features.safe_account` | boolean | `false` |
| `data.mobile_auth_platforms.android` | boolean | `true` |
| `data.mobile_auth_platforms.ios` | boolean | `false` |
| `data.deployment_identity` | object, optional | Present only when `CHAIN_NETWORK` and `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` are both set |
| `data.deployment_identity.environment` | string | The value of `NODE_ENV` |
| `data.deployment_identity.chain_id` | integer | `8453` when `CHAIN_NETWORK` is `base`, otherwise `84532` |
| `data.deployment_identity.network` | `"base"` or `"base-sepolia"` | `CHAIN_NETWORK` |
| `data.deployment_identity.registry_address` | string | `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS` |

The shape is defined at `src/modules/auth/api/customer/device-auth.schemas.ts:5-23`; the values are constants at `src/server.ts:660-678`, and the `deployment_identity` condition is at `src/server.ts:670-677`. `mobile_auth_platforms` is derived from the same policy that enrolment and login enforce, `ANDROID_ONLY_MOBILE_PLATFORM_POLICY` (`src/server.ts:279`, `src/modules/auth/domain/mobile-platform.policy.ts:29-34`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 401 | `DPOP_PROOF_MISSING` | No `DPoP` header |
| 401 | `DPOP_PROOF_INVALID` | The proof is malformed, not ES256 with an embedded public P-256 key, has a wrong `htm` or `htu`, an `iat` more than 60 seconds from the server clock, or a `jti` outside `^[A-Za-z0-9_-]{16,64}$` (`src/modules/auth/application/shared/dpop-proof-verifier.ts:134-206`) |
| 401 | `DPOP_REPLAY` | The same `(jkt, jti)` was recorded within the last 120 seconds |

**Notes.** Every call records one row in `auth.dpop_replays`, so each call needs a new `jti`. The flags and `min_app_version` are not stored anywhere and cannot be changed without a deploy; the plan suggests an operator-settable `min_app_version` row (`docs/plans/device-bound-auth-backend.md:355`), and no `app_config` exists in `prisma` or `src` (searched). `deployment_identity.environment` is `production` on staging too, because the images set `NODE_ENV=production` and staging only adds `APP_ENV=staging` (`docker-compose.staging.yml:151`); see [Known limitations](#known-limitations).

**Source.** `src/modules/auth/api/customer/device-auth.router.ts:98-121`, `src/modules/auth/api/customer/device-auth.schemas.ts:5-23`.

### POST /v1/auth/mobile/enrol/challenge

**Auth.** A DPoP proof, no session (E1).

**Mounted when.** Always on main (see above).

**Request.** No body is read. Header `DPoP: <proof>` for `POST /v1/auth/mobile/enrol/challenge`.

**Success.** `200 { data: { challenge, expires_at } }`. `challenge` is 32 random bytes, base64url encoded (43 characters); `expires_at` is an ISO-8601 time, the expiry the database recorded: the database clock plus 300 seconds (`src/modules/auth/api/customer/device-auth.router.ts:20`, `src/modules/auth/application/customer/device-challenge-issuance.service.ts:28`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 401 | `DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID`, `DPOP_REPLAY` | As for C1 |
| 429 | `rate_limit.exceeded` | More than 10 requests in 60 seconds from one address, or from one DPoP key; `Retry-After: 60`. Only when a rate-limit store was configured |
| 500 | `internal.dpop_jkt_missing` | The proof middleware left no key on the response. Defensive; not reachable through the mounted router |

**Notes.** The challenge row is stored with purpose `enrol-device`, the proof's key thumbprint and no device. It is single use and is spent by E2, which requires the same DPoP key (`src/modules/auth/api/customer/device-auth.router.ts:163-176`). The call needs no account and creates one `auth.device_challenges` row per call, so the limiters are the only gate; without Redis there is none (see [Known limitations](#known-limitations)).

**Source.** `src/modules/auth/api/customer/device-auth.router.ts:163-176`, `src/modules/auth/application/customer/device-challenge-issuance.service.ts:22-37`.

### POST /v1/auth/mobile/enrol/verify

**Auth.** A live `oauth_pending` session sent as `Authorization: Bearer <token>`, bound to the DPoP key of the request, and a DPoP proof whose `ath` is the base64url SHA-256 of that token (E2). The router first runs `requireDpopOnlyForVerify` (no `ath` check, no record); the plugin then verifies and records the proof again, with the `ath` check (`src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:81-111`).

**Mounted when.** Always on main (see above).

**Request.** JSON body (`src/modules/auth/api/customer/device-auth.schemas.ts:46-50`):

| Field | Type | Rule |
| --- | --- | --- |
| `challenge` | string | Non-empty; the value E1 returned |
| `jws` | string | Non-empty; the device JWS (typ `vistablox-device-auth+jwt`, purpose `enrol-device`, carrying the biometric public key), see [../authentication.md](../authentication.md#device-signature-jws) |
| `attestation` | object | Discriminated by `platform`; below |

| `attestation.platform` | Fields | Outcome on main |
| --- | --- | --- |
| `"android"` | `key_attestation_chain` (array of strings, at least one), `integrity_token` (string, optional) | Verified; see [../authentication.md](../authentication.md#attestation) |
| `"ios"` | `app_attest_key_id` (non-empty string), `attestation_object` and `assertion` (non-empty strings, optional) | Accepted by the schema, then refused with `400 MOBILE_PLATFORM_NOT_SUPPORTED` |

The attestation shapes are defined at `src/modules/auth/application/customer/mobile-attestation.schemas.ts:3-19`.

**Success.** `200 { data: { device_id, status: "active", session_expires_at, authentication_level: "device_biometric" } }` and the header `set-auth-token: <new session token>`, which the router copies from the ceremony (`src/modules/auth/api/customer/device-auth.router.ts:277-285`). `session_expires_at` is the creation time plus 30 minutes. The pending session is deleted and every other live `device_biometric` session of the same user and key is revoked. The body is parsed through `enrolVerifyResponseSchema` (`src/modules/auth/api/customer/device-auth.schemas.ts:52-59`).

**Errors.** In the order they can occur.

| Status | Code | Condition |
| --- | --- | --- |
| 401 | `DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID`, `DPOP_REPLAY` | The router's proof check failed |
| 429 | `rate_limit.exceeded` | Tight IP or DPoP-key limiter; `Retry-After: 60`. Only with a rate-limit store |
| 422 | `validation.invalid_field` | The body fails the schema above |
| 400 | `DEVICE_JWS_INVALID` | No session, or a session whose level is not `oauth_pending` ("A pending Google/Apple sign-in session is required before enrolling a device."), or a pending session that is not bound to a key ("This session is not yet bound to a device key.") |
| 401 | `DPOP_KEY_MISMATCH` | The proof verifies but its key is not the key the pending session is bound to |
| 401 | `DPOP_PROOF_INVALID`, `DPOP_REPLAY` | The second verification failed, for example the proof has no `ath` or a wrong one |
| 500 | `device.account_mapping_missing` | The session's user has no local account |
| 403 | `ACCOUNT_RESTRICTED` | The account status is not `active` |
| 400 | `MOBILE_PLATFORM_NOT_SUPPORTED` | `attestation.platform` is `ios`; the policy supports Android only |
| 409 | `DEVICE_ALREADY_ENROLLED` | The account already has an active device. Checked before the challenge is spent. The same code is also answered, after the challenge is spent and the JWS verified, when this DPoP key is already an active device, and when a challenge that was used more than 120 seconds ago is presented and a device was registered for the key or the account in the meantime (`src/modules/auth/application/customer/device-enrolment.service.ts:106-109`, `src/modules/auth/application/customer/device-enrolment.service.ts:169-188`) |
| 400 | `DEVICE_CHALLENGE_REPLAYED` | The challenge was used less than 120 seconds ago (database clock) |
| 400 | `DEVICE_CHALLENGE_EXPIRED` | The challenge is unknown, unused past its 300 seconds, used more than 120 seconds ago with no device registered, or was consumed more than 60 seconds before the insert |
| 400 | `DEVICE_CHALLENGE_PURPOSE_MISMATCH` | The JWS `purpose` claim is not `enrol-device` |
| 400 | `DEVICE_JWS_INVALID` | The challenge was consumed, then the JWS failed verification (malformed, `typ`, `alg`, `kid`, embedded `jwk`, signature, `challenge`, `iat`) or its `dpop_jkt` claim differs from the proof's key (`src/modules/auth/application/customer/device-auth-jws-verifier.ts:112-201`) |
| 400 | `ATTESTATION_INVALID`, `ATTESTATION_CHALLENGE_MISMATCH` | The Android key attestation or the Play Integrity verdict fails, or the attested challenge differs from the enrolment challenge. The message is always "This device can't be used for VistaBlox."; the reason is logged server-side only |
| 409 | `DEVICE_ALREADY_ENROLLED` | A concurrent enrolment inserted a device first (unique-index conflict) |
| 500 | `device.session_creation_failed` | The device row was written but no session could be created; the row is deleted again. Any other failure after the device insert also deletes the row and the new session, and answers `500 internal.unexpected` (`src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:193-219`) |

The order comes from `src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:71-222` and `src/modules/auth/application/customer/device-enrolment.service.ts:61-142`; the status of each code is set in `src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:443-476`; the windows are `src/modules/auth/domain/device-challenge-replay.ts:39-40`.

**Notes.** A successful E2 writes one `auth.devices` row (one active device per account, one device per DPoP key; partial unique indexes) and the account's `device_key` login method in one transaction. E2 stores no device model, OS version or app version although the columns exist (`src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:141-143`). The two door problem (the ceremony is also served at `/api/auth/device/enrol/verify`) is in [better-auth.md](better-auth.md).

**Source.** `src/modules/auth/api/customer/device-auth.router.ts:178-209`, `src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:71-222`.

### POST /v1/auth/mobile/login/challenge

**Auth.** A DPoP proof, no session (L1).

**Mounted when.** Always on main (see above).

**Request.** An optional JSON body `{ "device_id": string }` (non-empty when sent). The handler reads `request.body ?? {}` (`src/modules/auth/api/customer/device-auth.router.ts:213`). Header `DPoP: <proof>`.

**Success.** `200 { data: { challenge, expires_at, attestation_required } }`. `attestation_required` is always `false`: re-attestation is not built (`src/modules/auth/api/customer/device-auth.router.ts:225`). The challenge expires 120 seconds after the database clock (`src/modules/auth/api/customer/device-auth.router.ts:21`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 401 | `DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID`, `DPOP_REPLAY` | As for C1 |
| 429 | `rate_limit.exceeded` | Tight IP or DPoP-key limiter |
| 422 | `validation.invalid_field` | `device_id` is an empty string or not a string |
| 500 | `internal.dpop_jkt_missing` | Defensive, as for E1 |

**Notes.** The challenge has purpose `login`. It is bound to the device that owns the proof's key, if there is one, whatever `device_id` was sent; a sent `device_id` is used only when the key belongs to no device. A challenge is issued in every case, so the answer does not reveal whether a device exists; L2 refuses a mismatching `device_id` (`src/modules/auth/application/customer/device-challenge-issuance.service.ts:49-61`).

**Source.** `src/modules/auth/api/customer/device-auth.router.ts:211-229`.

### POST /v1/auth/mobile/login/verify

**Auth.** A DPoP proof and the device signature (L2). The `Authorization` header is ignored, so a stale token never fails this call.

**Mounted when.** Always on main (see above).

**Request.** JSON body (`src/modules/auth/api/customer/device-auth.schemas.ts:61-65`):

| Field | Type | Rule |
| --- | --- | --- |
| `device_id` | string, optional | Non-empty when sent; must be the device that owns the proof's key |
| `challenge` | string | Non-empty; the value L1 returned |
| `jws` | string | Non-empty; the device JWS with purpose `login`, signed with the biometric key |

**Success.** `200 { data: { device_id, session_expires_at, authentication_level: "device_biometric" } }` and the header `set-auth-token: <new session token>`. The session is bound to the proof's key, lives at most 30 minutes and idles out after 5 minutes without a request; every earlier `device_biometric` session of the same key is revoked (`src/modules/auth/api/customer/device-auth.schemas.ts:67-73`).

**Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 401 | `DPOP_PROOF_MISSING`, `DPOP_PROOF_INVALID`, `DPOP_REPLAY` | The proof check failed |
| 429 | `rate_limit.exceeded` | Tight IP or DPoP-key limiter |
| 422 | `validation.invalid_field` | The body fails the schema above |
| 401 | `DEVICE_LOGIN_FAILED` | One answer for: no device owns the key, the device is not `active`, `device_id` does not match, the JWS fails (signature, `typ`, claims, purpose, `iat`) (`src/modules/auth/application/customer/device-login.service.ts:43-53`, `src/modules/auth/application/customer/device-login.service.ts:95-99`) |
| 400 | `MOBILE_PLATFORM_NOT_SUPPORTED` | The stored device's platform is not in the platform policy |
| 400 | `DEVICE_CHALLENGE_REPLAYED`, `DEVICE_CHALLENGE_EXPIRED` | The challenge was used within 120 seconds, or is unknown, expired or used longer ago |
| 403 | `ACCOUNT_RESTRICTED` | The account is missing or its status is not `active` |
| 500 | `device.session_creation_failed`, `device.account_mapping_missing` | The session or the user could not be created or found; a session already created is discarded |

**Notes.** L2 updates the device's last-seen time once the signature has verified, before the account status check and the session creation (`src/modules/auth/application/customer/device-login.service.ts:102`). A challenge that was spent on a failed attempt stays spent: a new L1 call is needed. Login does not re-attest (`src/modules/auth/application/customer/device-login.service.ts:27`).

**Source.** `src/modules/auth/api/customer/device-auth.router.ts:231-259`, `src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:223-312`, `src/modules/auth/application/customer/device-login.service.ts:31-104`.


## Device replacement

A customer who reinstalled the app or bought a new phone can replace the enrolled device without staff: an email code, proved with a live session, revokes the active device so that the new phone can enrol. The flow, its limits and the comparison with staff recovery are in [../authentication.md](../authentication.md#device-replacement). Both routes run `requireAuthentication` only, so the caller needs a `device_biometric` session (or a staff session, which the service then refuses); see [Known limitations](#known-limitations), item 1, for what that means for a reinstalled app.

### POST /v1/auth/mobile/replacement/request

- **Auth.** `requireAuthentication` (baseline limiter 300 per 60 s per account). No population check in the middleware; the service refuses an account with an active staff role. No fresh authentication, no idempotency key.
- **Mounted when.** `protectedApi.deviceReplacement` is set, which `server.ts` always does (`src/server.ts:680-683`, `src/app.ts:812-816`).
- **Request.** No body is read, no query.
- **Success.** `202` with an empty body, also when the account has no bound email address (so the answer never reveals whether an email exists).
- **Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 404 | `authentication.device_replacement_target_not_found` | The session's account row does not exist |
| 409 | `authentication.device_replacement_target_is_staff` | The account has an active staff role; use staff recovery |
| 409 | `authentication.device_replacement_cooldown` | A code was consumed less than `DEVICE_REPLACEMENT_COOLDOWN_HOURS` (default 72) ago; see [Known limitations](#known-limitations), item 2, for what counts as consumed |
| 429 | `authentication.device_replacement_request_rate_limited` | `DEVICE_REPLACEMENT_RATE_LIMIT_PER_HOUR` (default 3) codes were created for this account in the last hour |

- **Notes.** In order: load the target; stop with an audit row `authentication.device_replacement_unavailable` (reason `no_bound_email`) if the account has no `protected_contact_email`; check the cooldown; check the hourly cap; generate six random decimal digits; mark every unconsumed code of the account as consumed; insert `auth.device_replacement_codes` (SHA-256 hash only, bound to the calling Better Auth session id, expiry `DEVICE_REPLACEMENT_CODE_TTL_MINUTES`, default 10); write `authentication.device_replacement_requested`; send the email through the SMTP sender. A delivery failure is swallowed: the code is stored and the customer asks again (`src/modules/auth/application/customer/device-replacement.service.ts:33-110`). The steps are separate statements, not one transaction.
- **Source.** (`src/modules/auth/api/customer/device-replacement.router.ts:27-34`), `RequestDeviceReplacementService` in (`src/modules/auth/application/customer/device-replacement.service.ts:25`), `PrismaDeviceReplacementRepository` in (`src/modules/auth/repository/customer/prisma-device-replacement.repository.ts:29`).

### POST /v1/auth/mobile/replacement/verify

- **Auth.** As the request route.
- **Mounted when.** As the request route.
- **Request.** JSON body `{ "code": string }`, matching `^\d{6}$` (`src/modules/auth/api/customer/device-replacement.schemas.ts:5-6`).
- **Success.** `204` with an empty body.
- **Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 422 | `validation.invalid_field` | `code` is not six digits |
| 404 | `authentication.device_replacement_target_not_found` | As for the request |
| 409 | `authentication.device_replacement_target_is_staff` | As for the request |
| 400 | `authentication.device_replacement_code_invalid` | No unconsumed, unexpired code exists for the account; the code was issued to another session; the code is wrong (the attempt counter is incremented); or the attempt cap `DEVICE_REPLACEMENT_MAX_ATTEMPTS` (default 5) was reached. One answer for all, so a caller cannot tell them apart |

- **Notes.** The comparison is constant time over the SHA-256 hashes. The right code is consumed and the replacement is applied in one transaction: the code row gets `consumed_at`, every active `auth.devices` row of the account becomes `revoked` with `revocation_reason = device_replacement`, the account's `device_key` login method is deleted, and the audit rows `authentication.device_revoked` (one per device), `authentication.login_method_removed` (only when a `device_key` row existed) and `authentication.device_replacement_completed` are written (`src/modules/auth/repository/customer/prisma-device-replacement.repository.ts:94-192`). No session is ended, so the old phone's session lives until its own limits (at most 30 minutes). The route does not check the cooldown; the request route does. After success the customer runs E1 and E2 on the new device; E2 needs an `oauth_pending` session, which means a fresh Google or Apple sign-in on that device.
- **Source.** (`src/modules/auth/api/customer/device-replacement.router.ts:37-46`), `VerifyDeviceReplacementService` in (`src/modules/auth/application/customer/device-replacement.service.ts:125`).

## Sessions

These routes read and end the caller's sessions. They work on the product-facing mirror `auth.sessions` for listing and on Better Auth's own session table for revocation; Better Auth's table alone decides whether a request authenticates ([../authentication.md](../authentication.md#sessions)). None of them checks the population, so a staff session can call them for its own account.

### GET /v1/auth/sessions

- **Auth.** `requireAuthentication`.
- **Mounted when.** `protectedApi.customerSessions` is set (always in `server.ts`; `createApp` throws at start when it is set without the fresh-authentication middleware) (`src/app.ts:886-888`).
- **Request.** No parameters.
- **Success.** `200 { "data": [ ... ] }`, header `Cache-Control: no-store`, parsed through `listOwnSessionsResponseSchema`. Rows are ordered by `last_seen_at`, newest first, with no limit or paging (`src/modules/auth/repository/customer/prisma-customer-session.repository.ts:11-14`). Each item:

| Field | Type | Meaning |
| --- | --- | --- |
| `session_id` | string | The mirror id (`sess_<ulid>`), not Better Auth's id; the value the revoke route takes |
| `channel` | string | `mobile` when the session is `device_biometric` or bound to a DPoP key, otherwise `web` |
| `device_label` | string or null | A coarse label derived from the `User-Agent` (for example `Chrome on Android`), or null |
| `auth_method_at_login` | string | `google`, `apple`, `device_biometric`, `staff_passkey`, or `unknown` |
| `created_at`, `last_seen_at` | ISO-8601 string | Creation and last accepted request |
| `status` | string | The mirror's status: `active` or `revoked` |
| `revocation_reason` | string or null | `sign_out`, `self_revoke_one`, `self_revoke_all`, `self_revoke_others`, `rotated`, `superseded`, `ceremony_failed`, `expired` or `internal` |
| `is_current` | boolean | True for the session that made this request |

  The schema is (`src/modules/auth/api/customer/customer-session.schemas.ts:15-26`); the values of `channel` and `authMethodAtLogin` are set in (`src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:362-368`) and (`src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:418-432`); the reasons in (`src/modules/auth/infrastructure/shared/better-auth-audit.plugin.ts:460-468`).
- **Errors.** Only the common and authenticated errors.
- **Notes.** A row still marked `active` whose Better Auth session has expired or has passed a device limit is left out, because the mirror is never told when a session merely times out; the caller's own row is always kept (`src/modules/auth/application/customer/customer-session.service.ts:15-33`, `src/modules/auth/domain/session-liveness.ts:38`). Revoked rows are listed as history, without a bound on their number.
- **Source.** (`src/modules/auth/api/customer/customer-session.router.ts:27-32`).

### POST /v1/auth/sessions/revoke-all

- **Auth.** `requireAuthentication`, then `requireFreshAuthentication` (a `device_biometric` session created within 5 minutes; otherwise `403 authentication.fresh_auth_required`).
- **Mounted when.** As `GET /v1/auth/sessions`.
- **Request.** No body (any body is ignored).
- **Success.** `204`, empty body. The caller's own session ends as well: the next request answers `401`.
- **Errors.** `403 authentication.fresh_auth_required`.
- **Notes.** Calls Better Auth's `revokeSessions` in process, which deletes every session row of the user through the delete hooks; the audit rows and the mirror record each one with reason `self_revoke_all`. It does not cancel signing requests, although the plan says it does ([../authentication.md](../authentication.md#plan-versus-built)).
- **Source.** (`src/modules/auth/api/customer/customer-session.router.ts:49-55`), (`src/modules/auth/infrastructure/customer/better-auth-session-revoker.ts:32-35`).

### POST /v1/auth/sessions/:session_id/revoke

- **Auth.** `requireAuthentication`, then `requireFreshAuthentication`.
- **Mounted when.** As `GET /v1/auth/sessions`.
- **Request.** Path parameter `session_id`: a non-empty string, the `session_id` of the list (`src/modules/auth/api/customer/customer-session.schemas.ts:3-4`).
- **Success.** `204`, empty body.
- **Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authentication.fresh_auth_required` | The session is not fresh |
| 404 | `resource.not_found` | No mirror row with that id belongs to the caller's account, or the row has no Better Auth session id |

- **Notes.** Ownership is checked on the mirror by `(id, account_id)`; the token is then found only in the caller's own live session list, so another account's session is unreachable. A session that has already ended answers `204` without doing anything. Revoking the current session is allowed and ends the caller's access.
- **Source.** (`src/modules/auth/api/customer/customer-session.router.ts:60-67`), `RevokeOwnSessionService` in (`src/modules/auth/application/customer/customer-session.service.ts:53`).

### POST /v1/auth/sessions/devices/:jkt/revoke

- **Auth.** `requireAuthentication`, then `requireFreshAuthentication`.
- **Mounted when.** The router receives a `RevokeDeviceSessionsService`, which `createApp` always builds when `customerSessions` is set. `server.ts` supplies `cancelPendingSigningRequestsForDevice` (`src/server.ts:712-718`).
- **Request.** Path parameter `jkt`: a non-empty string, the RFC 7638 thumbprint of a DPoP key (`src/modules/auth/api/customer/customer-session.schemas.ts:7-8`). There is no format check.
- **Success.** `200 { "data": { "revoked_count": <integer> } }`, header `Cache-Control: no-store`, parsed through `revokeDeviceResponseSchema`. `revoked_count` is the number of the caller's own sessions bound to that key that were ended, the current one included when it is bound to it. It does not count signing requests.
- **Errors.** `403 authentication.fresh_auth_required`. See [Known limitations](#known-limitations), item 4, for a case where the route answers `500`, and item 3 for the scope of the cancellation.
- **Notes.** In order: list the caller's sessions through Better Auth and revoke each one whose `dpopJkt` equals the parameter (audit reason `self_revoke_one`); then, unconditionally, look up the active device that owns the key and set every `pending` and `signed` signing request of that device to `cancelled`. The cancellation does not check that the device belongs to the caller. The device row is not changed: it stays `active`, and that phone can still run L1 and L2 (`src/modules/auth/application/customer/customer-session.service.ts:97-108`, `src/modules/auth/application/customer/cancel-signing-requests.service.ts:16-19`, `src/modules/auth/repository/customer/prisma-signing-request.repository.ts:173-178`).

  > Pending #234: the cancellation is limited to the caller's own signing requests; on main it is not scoped to the caller.
- **Source.** (`src/modules/auth/api/customer/customer-session.router.ts:71-82`), (`src/modules/auth/infrastructure/customer/better-auth-session-revoker.ts:43-52`).

## Login methods

### POST /v1/auth/login-methods/:method_type/unlink

- **Auth.** `requireAuthentication`, then `requireFreshAuthentication`. No population check.
- **Mounted when.** `protectedApi.loginMethods` is set (always in `server.ts`); `createApp` throws at start when it is set without the fresh-authentication middleware (`src/app.ts:729-737`, `src/server.ts:636-637`).
- **Request.** Path parameter `method_type`: `google` or `apple` (`src/modules/auth/api/customer/login-methods.schemas.ts:3-4`). No body.
- **Success.** `204`, empty body.
- **Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 422 | `validation.invalid_field` | `method_type` is neither `google` nor `apple` |
| 403 | `authentication.fresh_auth_required` | The session is not fresh |
| 404 | `authentication.login_method_not_linked` | The user has no linked account for that provider |
| 409 | `authentication.registration_login_method_locked` | The provider is the identity the account was registered with (the earliest linked account), or it is the user's only linked identity |

- **Notes.** The route lists the caller's linked accounts through Better Auth, finds the one whose provider matches, and calls `unlinkAccount` in process. The registration guard runs on that call and raises `REGISTRATION_LOGIN_METHOD_LOCKED`; the library raises `FAILED_TO_UNLINK_LAST_ACCOUNT` for a last account, which the guard, being a before-hook, normally pre-empts; the service maps both to the 409 above and `ACCOUNT_NOT_FOUND` to the 404. A customer can therefore only remove an identity they added after registering. The `auth.login_methods` row is not deleted and no audit row is written ([Known limitations](#known-limitations), item 6). The same action over Better Auth's own route is `POST /api/auth/unlink-account` ([better-auth.md](better-auth.md#post-unlink-account)).
- **Source.** (`src/modules/auth/api/customer/login-methods.router.ts:13-21`), `UnlinkLoginMethodService` in (`src/modules/auth/application/customer/unlink-login-method.service.ts:11`), `BetterAuthLoginMethodUnlinker` in (`src/modules/auth/infrastructure/customer/better-auth-login-method-unlinker.ts:18`).

## Account closure

A customer asks to close the account; a staff member with the `admin_operations` role decides ([auth-staff.md](auth-staff.md)). Neither route restricts the account or ends a session: the customer keeps using the product until a decision is made. On approval the staff route deletes every session of the user, sets `recoveryRequiredAt`, moves the account to `suspended_restricted` and writes `authentication.customer_account_closed` ([../authentication.md](../authentication.md#customer-account-lifecycle)).

### POST /v1/auth/account-closure

- **Auth.** `requireAuthentication`; the handler then refuses any population except `customer` with `403 authorization.forbidden`. No fresh authentication, no idempotency key.
- **Mounted when.** `protectedApi.accountClosure` is set (always in `server.ts`) (`src/app.ts:1024-1027`).
- **Request.** Optional JSON body `{ "reason": string }`, trimmed, 1 to 1000 characters (`src/modules/auth/api/shared/account-closure.schemas.ts:3-4`). A missing body is treated as `{}`.
- **Success.** `201`, parsed through `accountClosureRequestResponseSchema`:

| Field | Type | Value |
| --- | --- | --- |
| `data.closure_request_id` | string | `closure_request_<ulid>` |
| `data.account_id` | string | The caller's account id |
| `data.status` | string | `pending` |
| `data.reason` | string or null | The reason sent, or null |
| `data.requested_at` | ISO-8601 string | The server time |
| `data.resolved_at`, `data.resolved_by`, `data.resolution_note` | string or null | `null` while pending |

- **Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `authorization.forbidden` | The session is not a customer session |
| 422 | `validation.invalid_field` | `reason` is empty after trimming or longer than 1000 characters |
| 404 | `account_closure.target_not_found` | The account row does not exist |
| 409 | `account_closure.target_not_active` | The account status is not `active` |
| 409 | `account_closure.request_already_pending` | The account has a request with status `pending` |

- **Notes.** Writes one row to `auth.account_closure_requests`. No job is enqueued and no audit row is written. The check for a pending request and the insert are two statements and the table has no unique constraint on a pending request per account, so two simultaneous calls can both succeed ([Known limitations](#known-limitations), item 7). The pending request is read by the profile module through `PendingClosureRequestReader`.
- **Source.** (`src/modules/auth/api/customer/account-closure.router.ts:21-28`), `RequestAccountClosureService` in (`src/modules/auth/application/shared/account-closure.service.ts:8`), `PrismaAccountClosureRepository` in (`src/modules/auth/repository/shared/prisma-account-closure.repository.ts:13`).

### POST /v1/auth/account-closure/cancel

- **Auth.** As `POST /v1/auth/account-closure`, including the customer-only check.
- **Mounted when.** As above.
- **Request.** No body.
- **Success.** `200`, the same body as the request route with `status` `cancelled` and `resolved_at` set to the server time.
- **Errors.** `403 authorization.forbidden`; `404 account_closure.no_pending_request` when the account has no pending request, or the request was resolved between the read and the update.
- **Notes.** One conditional update (`status = pending` for this account), so a request that staff approved a moment earlier cannot be cancelled. No audit row.
- **Source.** (`src/modules/auth/api/customer/account-closure.router.ts:31-34`), `CancelAccountClosureService` in (`src/modules/auth/application/shared/account-closure.service.ts:33`).

## Signing requests (not mounted)

A signing request is a row that the device must sign with its biometric key before an action may proceed. The four routes below exist in code and answer `404 resource.not_found` on every deployment: `createApp` mounts them only when `appConfig.features.signing_requests === true`, and `server.ts` fixes that flag to `false`, with no environment variable behind it (`src/app.ts:796-801`, `src/server.ts:665`). Nothing creates a request either: the only creation path is `PrepareSigningRequestService`, which no code outside tests calls. What the subsystem is for and how it compares with the plan is in [../authentication.md](../authentication.md#signing-requests). The entries below describe the code as it would behave if the flag were set; none of it was run against a database.

All four routes run `router.use(requireAuthentication)` (baseline limiter, no population check, no fresh authentication, no idempotency key). T2 and T3 also need the session to be bound to a DPoP key; without one they answer `500 internal.dpop_jkt_missing`. The router maps its own error classes to the VistaBlox envelope; their `code` values are capitals with underscores (`src/modules/auth/api/customer/signing-requests.router.ts:251-329`).

### GET /v1/auth/signing-requests

- **Mounted when.** Never on main (see above).
- **Request.** Query `status`: one of `pending`, `signed`, `executed`, `expired`, `cancelled`; default `pending` (`src/modules/auth/api/customer/signing-requests.schemas.ts:47-48`).
- **Success.** `200 { "data": [ request, ... ] }`, newest first, with no limit. A `request` has `request_id`, `request_type` (an opaque label), `amount_minor` (decimal string or null), `currency` (string or null), `destination` (`{ kind: wallet | iban | contract, value, display_name? }` or null), `created_by` (`{ kind: user | platform | staff, label }`), `created_at`, `expires_at` and `status` (`pending`, `signed`, `executed`, `submitted`, `included`, `expired`, `cancelled`) (`src/modules/auth/api/customer/signing-requests.schemas.ts:16-34`).
- **Errors.** `422 validation.invalid_field` for an unknown `status`; `500 internal.auth_context_missing`.
- **Source.** (`src/modules/auth/api/customer/signing-requests.router.ts:68-74`).

### GET /v1/auth/signing-requests/:request_id

- **Mounted when.** Never on main.
- **Request.** Path parameter `request_id`, a non-empty string.
- **Success.** `200 { "data": request }`.
- **Errors.** `404 SIGNING_REQUEST_NOT_FOUND` when no request with that id belongs to the caller's account.
- **Source.** (`src/modules/auth/api/customer/signing-requests.router.ts:81-89`).

### POST /v1/auth/signing-requests/:request_id/challenge

- **Mounted when.** Never on main.
- **Request.** Path parameter `request_id`; body `{}` (an object; unknown keys are ignored).
- **Success.** `200 { "data": { "challenge": string, "expires_at": ISO-8601 } }`: 32 random bytes in base64url, purpose `tx`, valid 120 seconds, bound to the session's DPoP key and to the device. One `auth.device_challenges` row per call.
- **Errors.**

| Status | Code | Condition |
| --- | --- | --- |
| 404 | `SIGNING_REQUEST_NOT_FOUND` | No such request for this account |
| 403 | `TX_WRONG_DEVICE` | No active device owns the session's key, or the request belongs to another device |
| 409 | `REQUEST_EXPIRED` | The request is `expired`, or `pending` with `expires_at` in the past |
| 409 | `REQUEST_CANCELLED` | The request is `cancelled` |
| 409 | `REQUEST_ALREADY_CONSUMED` | Any other status (`signed`, `executed`, `submitted`, `included`) |
| 500 | `internal.dpop_jkt_missing` | The session is not bound to a key |

- **Source.** (`src/modules/auth/api/customer/signing-requests.router.ts:99-180`).

### POST /v1/auth/signing-requests/:request_id/sign

- **Mounted when.** Never on main.
- **Request.** Path parameter `request_id`. JSON body: `challenge` (non-empty string, the value T2 returned), `jws` (non-empty string, the device signature) and `attestation` (the same object as E2, required by the schema but not examined by the handler) (`src/modules/auth/api/customer/signing-requests.schemas.ts:70-73`). The JWS has header `typ: vistablox-device-auth+jwt`, `alg: ES256`, `kid` equal to the thumbprint of the device's stored biometric key and no embedded `jwk`; claims `purpose: "tx"`, `challenge`, `iat` (within 60 seconds), `device_id` (must equal the device id), and the transaction claims `request_id`, `request_type`, `amount_minor`, `currency`, `destination` (`kind`, `value`), `created_by` (`kind`, `label`), `created_at` and `expires_at`, the last two as the exact ISO-8601 strings that T1 returned (`src/modules/auth/domain/signing-request.policy.ts:198-233`).
- **Success.** `200 { "data": { "status": "signed" } }`. The schema also allows `submitted` and `executed`; the code never produces them, because no executor is registered.
- **Errors.** In the order the service checks them:

| Status | Code | Condition |
| --- | --- | --- |
| 403 | `TX_WRONG_DEVICE` | No active device owns the session's key |
| 404 | `SIGNING_REQUEST_NOT_FOUND` | No such request for this account |
| 409 | `REQUEST_ALREADY_CONSUMED`, `REQUEST_EXPIRED`, `REQUEST_CANCELLED` | The request is `executed`; or past `expires_at`; or `expired`, `cancelled`, or any status other than `pending` (as for T2) |
| 403 | `TX_WRONG_DEVICE` | The request belongs to another device |
| 400 | `DEVICE_CHALLENGE_REPLAYED`, `DEVICE_CHALLENGE_EXPIRED` | The single-use `tx` challenge was used in the last 120 seconds, or is unknown, expired or used longer ago |
| 401 | `TX_SIGNATURE_INVALID` | The JWS fails for any reason: header, signature, purpose, challenge, `iat`, `device_id`, malformed transaction claims. The message names the reason |
| 409 | `TX_FIELD_MISMATCH` | A signed transaction claim differs from the stored request; the detail names the field |
| 409 | `REQUEST_ALREADY_CONSUMED` | A concurrent call signed the request first, or it expired during the ceremony (the update is `pending` and `expires_at > now()` on the database clock) |
| 500 | `internal.dpop_jkt_missing` | The session is not bound to a key; the router raises this before the service runs, so it comes first (`src/modules/auth/api/customer/signing-requests.router.ts:136`, `src/modules/auth/api/customer/signing-requests.router.ts:171-178`) |

- **Notes.** The challenge is spent before the JWS is checked, so a failed signature or a field mismatch burns it and the app must call T2 again. A success writes `signed_jws` and `signed_at` and sets the status to `signed` in one conditional update. Nothing is audited. `auth.signing_requests` rows leave `signed` only by expiring (`maintenance.signing_request_prune`) or by cancellation on device revoke ([../authentication.md](../authentication.md#background-jobs)).
- **Source.** (`src/modules/auth/api/customer/signing-requests.router.ts:133-146`), `AuthorizeSigningRequestService` in (`src/modules/auth/application/customer/authorize-signing-request.service.ts:46`), (`src/modules/auth/repository/customer/prisma-signing-request.repository.ts:136-152`).

## Known limitations

Defects and sharp edges found while reading the routes in this file. They are stated as found and are not fixed here. The chapter-level list, with the numbering used by the other documents, is in [../authentication.md](../authentication.md#known-limitations).

| # | Finding | Evidence | Issue |
| --- | --- | --- | --- |
| 1 | **The replacement routes need a session that the customer they are for cannot have.** `requireAuthentication` accepts only `staff_passkey` and `device_biometric` sessions. A reinstalled app can obtain only an `oauth_pending` session; E2 refuses it while the old device is active, and L2 needs the old DPoP key. So `POST /v1/auth/mobile/replacement/request` answers `401 authentication.required` to that customer. Read from the code; not run against a server | (`src/modules/auth/infrastructure/shared/better-auth-session.resolver.ts:67-71`), (`src/server.ts:476-481`), (`src/modules/auth/application/customer/device-enrolment.service.ts:79-83`) | none found |
| 2 | **A superseded code counts as a completed replacement for the cooldown.** Requesting a new code marks every unconsumed code of the account as consumed (`consumed_at = now`), and the cooldown check reads the latest `consumed_at` of any code. A customer who requests twice without finishing (a first email that never arrived, then a second request) is refused the third request with `409 authentication.device_replacement_cooldown` for 72 hours, although no device was replaced; the hourly cap of 3 can never be reached for the same reason. The second code stays usable until it expires. The repository comment says `consumed_at` always means a completed replacement. Read from the code; the service test uses a mocked repository and no integration test covers it; not run | (`src/modules/auth/repository/customer/prisma-device-replacement.repository.ts:76-82`), (`src/modules/auth/repository/customer/prisma-device-replacement.repository.ts:196-199`), (`src/modules/auth/repository/customer/prisma-device-replacement.repository.ts:107-108`) | none found |
| 3 | **Device revoke cancels signing requests without checking that the caller owns the device.** The route discards the caller's account id, the hook looks the device up by key alone, and the `UPDATE` filters by device id only; the session revocation next to it is scoped to the caller. It needs the other device's key thumbprint, and no request exists today because nothing creates one | (`src/modules/auth/api/customer/customer-session.router.ts:78-79`), (`src/modules/auth/application/customer/cancel-signing-requests.service.ts:17-19`), (`src/modules/auth/repository/customer/prisma-signing-request.repository.ts:173-178`) | #213 (PR #234) |
| 4 | **Device revoke can stop halfway with `500`.** It revokes the matching sessions one at a time with the caller's own credentials. When the current session is revoked first and another session of the caller is bound to the same key (for example a newer `oauth_pending` session from a second sign-in on the same install), the next revoke call has no live session and fails with 401; the error is not an `AppError`, so the route answers `500 internal.unexpected`, the remaining session stays alive and the signing-request cancellation does not run. The library behaviour (a second `revokeSession` with the same credentials fails once the first revoked the current session) was reproduced on a minimal in-memory Better Auth instance, not through this route | (`src/modules/auth/infrastructure/customer/better-auth-session-revoker.ts:43-52`); (`src/shared/http/error-handler.ts:46-67`) | none found |
| 5 | **The same route does not mark the device `revoked`.** The device keeps `status = 'active'` and can run L1 and L2 again; only replacement and recovery completion revoke a device row | (`src/modules/auth/application/customer/customer-session.service.ts:97-108`) | none found |
| 6 | **`auth.login_methods` is not kept in step with linking and unlinking.** `unlink` deletes no row, and `link-social` writes none, so `GET /v1/investor-profile` can list a method that is no longer linked. Eligibility is not affected, because the registration method cannot be unlinked | (`src/modules/auth/infrastructure/customer/better-auth-login-method-unlinker.ts:21-47`) | none found |
| 7 | **Two simultaneous account-closure requests can both be stored as `pending`.** The service reads the pending row and then inserts; the table has only a non-unique index on `account_id`. Not reproduced | (`src/modules/auth/application/shared/account-closure.service.ts:22-25`), (`prisma/migrations/20260910130000_add_account_closure_requests/migration.sql:18`) | none found |
| 8 | **Device replacement ends no session.** Sessions of the revoked device live until their own limits (at most 30 minutes) | (`src/modules/auth/repository/customer/prisma-device-replacement.repository.ts:94-192`) | none found |
| 9 | **`GET /v1/app/config` has no rate limiter and writes a replay row per call**, and E1 and L1 write a challenge row per call; the limiters on E1, E2, L1 and L2 exist only with Redis | (`src/app.ts:777-783`) | none found |
| 10 | **The Play Integrity decoder has no timeout and hides its failure reason.** Both Google calls are plain `fetch`; a fresh access token is fetched on every decode; any failure becomes `ATTESTATION_INVALID` ("This device can't be used for VistaBlox"), and the log line says only that the token could not be decoded, not why. Under `strict` in production a Google outage reads as a permanent device problem. The code comment says it was not tested against the real API | (`src/modules/auth/infrastructure/customer/google-play-integrity.decoder.ts:40-96`), (`src/modules/auth/application/customer/android-attestation-verifier.ts:328-330`) | none found |
| 11 | **E2 stores no model, OS version or app version,** although the columns exist | (`src/modules/auth/infrastructure/customer/better-auth-device-auth.plugin.ts:141-143`) | none found |
| 12 | **Signing requests: the attestation is required by the schema and ignored by the handler;** the policy file's header says an off-chain request reaches `executed` while the service stops at `signed`; `prisma/schema/auth.prisma` cites AD-097, which in the ledger is the minimum property value | (`src/modules/auth/api/customer/signing-requests.schemas.ts:70-73`), (`src/modules/auth/domain/signing-request.policy.ts:9-21`) | #220 (comments) |
| 13 | **The routes that read only `accountId` accept a staff session.** The sessions, login-methods, replacement and signing-request routes do not check the population; the replacement service refuses a staff target, the others act on the staff account's own data. No cross-account data was found | (`src/modules/auth/api/shared/auth-context.ts:1`) | none found |
| 14 | **A trace id is trusted as sent.** Any `x-trace-id` request header is copied into logs, the error envelope and audit `changes` | (`src/shared/http/request-context.ts:8-9`) | #217 |
| 15 | **`deployment_identity.environment` reports `NODE_ENV`,** which is `production` on staging as well, so the app cannot tell staging from production by it | (`src/server.ts:672`); (`docker-compose.staging.yml:154`) | none found |

## Not verified

* **Against a running server.** Nothing in this file was run against a live API or a database. The routes were read from the router, schema, service and repository files; Better Auth behaviour behind them (the in-process `listSessions`, `revokeSession`, `unlinkAccount` calls) was read from the installed library 1.7.2 and probed on an in-memory instance for the cases named above.
* **Real Android attestation and Play Integrity.** No real certificate chain or integrity token was verified, and the decoder's own comment says it was never run against the real API.
* **Email delivery.** The SMTP sender was not exercised. On staging the sender is the `maildev` container ([../authentication.md](../authentication.md#device-replacement)).
* **The mobile app.** What the app sends (headers, the order of calls, whether it reads `deployment_identity`) was not checked; the mobile repository was not available.
* **Staging and production configuration.** `.env.staging` is not in the repository, and no production configuration was seen: whether Redis-backed limiters exist, the `DEVICE_REPLACEMENT_*` values and the Play Integrity policy in each environment are not known.
* **PostgreSQL 18.** The local checks ran on 16.15.

## Related documents

* [../authentication.md](../authentication.md), [better-auth.md](better-auth.md), [auth-staff.md](auth-staff.md), [README.md](README.md)
* [../staff-access.md](../staff-access.md), [../security.md](../security.md), [../data-model.md](../data-model.md), [../configuration.md](../configuration.md)
* [../modules/auth.md](../modules/auth.md), [../account-recovery.md](../account-recovery.md), [../didit-kyc.md](../didit-kyc.md)
* [../plans/device-bound-auth-backend.md](../plans/device-bound-auth-backend.md)
