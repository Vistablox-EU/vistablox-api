# DevOps plan: device-bound biometric auth and self-custodial Safe wallet

**Owner:** vistablox-DevOps session · **Status:** plan only, awaiting Damir's review
**Revisions:**
- r1, 2026-09-11: items a–e (SMTP, recovery link host, push, attestation, keeping the plans).
- r2, 2026-09-11: Damir's wallet and biometric decisions. Adds wallet infrastructure in §10.
- r3, 2026-09-11, Damir directly: email goes **direct from the Coolify mail server, with no relay**; **one bundler provider**; the P-256 signer is option 1.
- r4, 2026-09-11, Damir directly: paymaster option A. **Coinbase CDP** sponsors gas (bundler + paymaster).
- r5, 2026-09-11: aligned with the final backend and mobile plans: native Safe modules (**no Safe7579**, to be confirmed); **eager Safe deployment**, with the mechanism an open question; the CDP key lives server-side only.
- **r6, 2026-09-11, Damir directly:**
  - **CDP confirmed**, and **CDP Node** is the RPC (free tier);
  - **no external audit budget** (§10.6: internal review, and Damir's sign-off gates mainnet);
  - account ownership later;
  - **no static IP**, since the mail server works as is;
  - DMARC reports are already running (§2.3);
  - **maildev over LAN: yes**;
  - **plans to GitHub as docs PRs: yes**;
  - **ETH reserve per wallet: yes** (§10.3a);
  - **Play Integrity: standard for login, strict for signing**;
  - **staging on Coolify only for now** (no production work).

**Hard rule:** no production changes (DNS, accounts, secrets, deploys) without Damir's explicit go-ahead. Claude cannot create accounts or enter credentials, so account creation is Damir's to do. After a go-ahead, I can make DNS changes (Cloudflare) and Coolify config changes.

**Wallet principle (Damir, r2):**
- VistaBlox has **zero control** over user wallets: no co-signer, no guardian, no HSM, no VistaBlox key over any user wallet.
- Only the device owner signs; VistaBlox only sends requests.
- Every piece of infrastructure below can at most *refuse to help*. None of it can move, freeze or redirect a user's funds.

This plan supports the backend plan (`vistablox-api` `docs/plans/device-bound-auth-backend.md`) and the mobile plan (`vistablox-mobile` `docs/plans/device-bound-auth-mobile.md`). Their section 3 (the wire contract) is byte-identical: 222 lines, sha256 `9e46b480849fc4a2…`.

---

## 0. Current state (verified 2026-09-11)

| Area | Finding |
|---|---|
| Environments | **Staging only** (Coolify on the laptop), and it stays that way for now (Damir, r6). `api.vistablox.io`, `admin.vistablox.io` and `mx.vistablox.io` → **24.135.205.210** (dynamic residential IP, `cable-24-135-205-210.dynamic.sbb.rs`). Laptop LAN: `192.168.1.245/24`, gateway `192.168.1.1`. |
| DNS | Cloudflare (`kyrie`/`candy.ns.cloudflare.com`). `api.vistablox.io` is not proxied. |
| Mail server | The Coolify service **`vistablox-mail`** (running, healthy): `docker-mailserver:latest` + `roundcube:latest-apache`. It's the MX for `vistablox.io`. Both images use **floating `:latest` tags**. |
| Outbound SMTP | Port 25 outbound is open. Gmail and iCloud MX greet with `220`; Microsoft (`mx1.hotmail.com`) gave no greeting within 8 s. The acceptance test (§2.5) settles deliverability. |
| Mail DNS | SPF `v=spf1 mx ~all` (softfail). **DMARC `p=quarantine; pct=100; rua=mailto:damir@vistablox.io`**, so aggregate reports are already flowing. DKIM selector `mail` exists. |
| Mail (API) | Staging sends into `maildev` (the compose file hardcodes `SMTP_HOST: maildev`, port 1025; web UI on host port 1080). |
| `.well-known` | `assetlinks.json` is served (`handle_all_urls` + `get_login_creds`, EAS key only). The AASA returns 404 until `PASSKEY_APPLE_TEAM_ID` is set. |
| Chain | `CHAIN_NETWORK` is a Base / Base Sepolia enum. Staging uses Base Sepolia via the public `https://sepolia.base.org`. Base mainnet gas on 2026-09-11: 0.006 gwei; ETH ≈ €2,128. |
| Mobile | No Firebase, push, Play Integrity or App Attest yet. **No Apple Developer account yet.** |

---

## 1. Summary and sequencing

| Track | Items | Blocked on | When |
|---|---|---|---|
| **A: staging, can start now** | Mail hardening + acceptance test (§2) · DMARC → reject (§2.3, needs a go-ahead) · Android App Link (§3) · FCM (§4) · Play Integrity + key attestation (§5) | The Play Console + Firebase/GCP accounts (Damir, later) | In step with the backend/mobile milestones |
| **B: blocked on Apple** | AASA `applinks` · APNs key · App Attest | Apple Developer enrolment (org + D-U-N-S) | Any iOS release |
| **D: wallet infra on Base Sepolia** | CDP Node RPC + CDP bundler/paymaster · public fallbacks · ETH reserve (Sepolia faucet) · ZK Email relayer · address registry · event watcher | The CDP account (payment method on file, even for the free tier) | With the backend/mobile wallet milestones |
| **Deferred (Damir, r6)** | Production hosting, production secrets, mainnet wallets | Damir's go-ahead | After dev testing |
| **(e)** | Plans on GitHub as docs PRs | Done in r6 (§6) | Now |

---

## 2. Email: direct from the Coolify mail server (**decided, r3/r6**)

### 2.1 Decision
- All outbound mail is sent **directly by `vistablox-mail`**, with no relay.
- Damir (r6): a static IP isn't needed, because the server already works.
- **The acceptance test (§2.5) is the proof** before recovery depends on email.

### 2.2 Setup
- **API → mail server:** the API submits over authenticated submission (587, STARTTLS) with a dedicated account (`security@vistablox.io` for security mail, `no-reply@vistablox.io` for the rest). The server DKIM-signs (`d=vistablox.io`, selector `mail`) and delivers. **Staging keeps `maildev`.**
- **Server hygiene:**
  - HELO `mx.vistablox.io`;
  - TLS on 25/587;
  - DKIM on for every sending account;
  - per-account rate limits;
  - no open relay.
- **Pin the images** (`docker-mailserver`, `roundcube`) to specific versions, instead of `:latest`.

### 2.3 DNS (Cloudflare)
- **Reporting is already running:** DMARC is `p=quarantine` with `rua=mailto:damir@vistablox.io`, so the observation window is effectively in progress.
- Once Damir confirms the reports show only legitimate, aligned sources (the mail server's DKIM `mail`, plus any Zoho or Google usage), two steps follow, **each after an explicit go-ahead**:
  1. Root SPF: `v=spf1 mx -all`.
  2. DMARC: `v=DMARC1; p=reject; sp=reject; adkim=r; aspf=r; pct=100; rua=mailto:damir@vistablox.io; fo=1`.
  - This affects all `@vistablox.io` mail, Damir's personal mail included.
- **Dynamic IP:** the MX A record, and so SPF `mx`, must follow any IP change. Confirm how `mx.vistablox.io` is kept current.
- **Optional, later:** MTA-STS + TLS-RPT; BIMI.

### 2.4 If deliverability ever degrades
Postmaster Tools (Google) and SNDS/JMRP (Microsoft), low and steady volume, clean bounces. A static IP with reverse DNS, or a relay, only if Damir decides.

### 2.5 Acceptance (before recovery depends on email)
- A test mail from `security@vistablox.io` to **Gmail, Outlook/Hotmail and iCloud** lands in the **inbox**, with `dkim=pass`, `spf=pass`, `dmarc=pass`.
- A mail-tester score of 10/10.
- After `p=reject`, a spoofed `From: security@vistablox.io` is rejected.
- The recovery email wording is exactly as the brief specifies.

### 2.6 Recovery-email testing on staging via maildev (**decided, r6**)
- **Damir runs, once:**
  ```
  sudo ufw route allow proto tcp from 192.168.1.0/24 to any port 1080 comment 'maildev web UI, LAN only'
  ```
- **Then, on the phone** (on the same Wi-Fi): open `http://192.168.1.245:1080`, open the recovery mail, and tap the link. The verified App Link opens the app.
- **Caveat:** if the laptop's DHCP address changes, use the new address. A DHCP reservation on the router makes it stable. The rule only admits the LAN range.

---

## 3. `api.vistablox.io` as the recovery link host

The link is `https://api.vistablox.io/r/recover#<token>`: single-use, 30 min. The token is in the fragment and never reaches the server.
- **Android:**
  - the server is ready (`handle_all_urls`);
  - the mobile intent filter uses `autoVerify`, host `api.vistablox.io`, `pathPrefix="/r/"`; verify with `adb shell pm get-app-links com.vistablox.app`;
  - for Play distribution later, add the Play App Signing key to `PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS`/`_ORIGINS`.
- **iOS (Track B):**
  - the AASA gets `applinks` with the component `"/": "/r/recover"`, next to `webcredentials`;
  - `applinks:api.vistablox.io` from `RECOVERY_LINK_HOST` (default `PASSKEY_RP_ID`);
  - validate via Apple's CDN.
- **Fallback page:** `GET /r/recover` is static, has no script, never reads the fragment, and sets `default-src 'none'` CSP, `noindex` and `no-referrer`.

---

## 4. Push

- Firebase per environment (**staging project now**), company-owned GCP org (later).
- The backend uses **FCM HTTP v1 only**; APNs goes through Firebase.
- The app uses **`@react-native-firebase/messaging`** for an FCM token on both platforms; `expo-notifications` handles the permission prompt and display.
- `google-services.json` / `GoogleService-Info.plist` are EAS file env vars, never committed.
- Server secrets: `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON` (FCM Admin role only).
- Payloads are content-free: "You have a pending action in VistaBlox", no actions. Security events also go out by email.

---

## 5. Play Integrity and App Attest

### 5.1 Android
- **Setup:**
  - Play Console (later) + Play Integrity standard requests;
  - `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` (build config);
  - `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` (decode only).
- **Policy (Damir r6: standard for login, strict for signing):**

  | Check | Production, login | Production, **signing** | Staging (sideloaded APKs) |
  |---|---|---|---|
  | `requestHash` == binding | required | required | required |
  | `appRecognitionVerdict` | `PLAY_RECOGNIZED` | `PLAY_RECOGNIZED` | also accepts `UNRECOGNIZED_VERSION` |
  | cert digest ∈ allowlist | Play App Signing key | Play App Signing key | EAS key |
  | `deviceRecognitionVerdict` | `MEETS_DEVICE_INTEGRITY` | **`MEETS_STRONG_INTEGRITY`** | `MEETS_DEVICE_INTEGRITY` for both. The strong check is logged, so we learn whether test phones pass it. |

  - `PLAY_INTEGRITY_POLICY=strict|relaxed`, and the API refuses `relaxed` in production.
  - **Strong integrity** needs hardware-backed boot attestation and a recent security patch. Some older phones will fail at signing (not at login). The app explains this plainly.
- **Key attestation:**
  - the `ANDROID_ATTESTATION_CERT_DIGESTS` allowlist;
  - all current Google roots pinned (updatable);
  - revocation list cached ≤ 24 h, fail closed beyond 72 h.
- **GMS-less devices are blocked; biometrics are mandatory** (no `device_credential`).

### 5.2 iOS (Track B)
- Apple org enrolment + D-U-N-S.
- App ID capabilities: App Attest, Push, Associated Domains, Sign in with Apple.
- The `appattest-environment` entitlement per profile must match `APP_ATTEST_ENVIRONMENT`.
- `APPLE_TEAM_ID`; the App Attestation root pinned.

---

## 6. Plans on GitHub (**done in r6, per Damir**)

- The three plans are committed as **docs-only PRs**, open for Damir's review and **not merged** until he approves them:
  - `vistablox-api`: `docs/plans/device-bound-auth-backend.md` + `docs/plans/devops-device-bound-auth.md`
  - `vistablox-mobile`: `docs/plans/device-bound-auth-mobile.md`
- **From now on, the PR branches are the canonical copies.** Later edits go to those branches.

---

## 7. Config and secret inventory (staging now; production names reserved)

| Name | Where | Secret | Notes |
|---|---|---|---|
| `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM` | API | password | staging = maildev; later → `vistablox-mail` 587 |
| `FCM_PROJECT_ID` / `FCM_SERVICE_ACCOUNT_JSON` | API | SA **yes** | §4 |
| `google-services.json` / `GoogleService-Info.plist` | EAS file env | config | never committed |
| `PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER` | EAS + API | no | |
| `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | API | **yes** | decode only |
| `PLAY_INTEGRITY_POLICY` | API | no | staging `relaxed`, prod `strict` |
| `ANDROID_ATTESTATION_CERT_DIGESTS` | API | no | |
| `APP_ATTEST_ENVIRONMENT`, `APPLE_TEAM_ID` | API | no | Track B |
| `WEBAUTHN_RP_ID` | API | no | `api.vistablox.io` (#51) |
| `CHAIN_NETWORK` | API + app | no | staging `base-sepolia` |
| `CHAIN_RPC_URLS` | API + app | CDP Node key **yes** | **CDP Node** first (free tier), public RPC last |
| `BUNDLER_URL` | **API only** | CDP key **yes** | CDP, server-side relay |
| `PAYMASTER_URL` + CDP policy id | **API only** | CDP key **yes** | CDP |
| `PUBLIC_BUNDLER_URLS` | app | no | the 7-day fallback |
| `CDP_PAYMASTER_ADDRESS` | app | no | pinned; checked against `paymasterAndData` |
| `EMAIL_RECOVERY_RELAYER_URL` | app + backend | no | §10.4 |
| `SAFE_*` / module addresses | API + app | no | pinned, bytecode-verified |
| `ETH_RESERVE_FUNDER_*` | API | **yes (staging: Sepolia test key only)** | §10.3a. Funds VistaBlox's own reserve wallet, never a user wallet key. |
| `SAFE_DEPLOYER_KEY` | API | **yes** | **only if** deployment option (b) is chosen. Not needed under the recommended (a). |

**CDP key handling (decided):** the key lives only in the API's Coolify secrets. The server relays every UserOp and gets `paymasterAndData` from CDP. **The app ships no CDP key.**

---

## 8. Schedule (staging only for now)

| When | DevOps | Damir |
|---|---|---|
| **Now** | Plans as PRs (§6). The maildev LAN rule (Damir runs it). Pin the mail images + hardening + the acceptance test mail (after a go-ahead). | Run the ufw command. Review the DMARC reports and give the SPF/DMARC go-ahead. Decide Safe7579 and the deployment mechanism (§11). Create the CDP account (a payment method is required even for the free tier). |
| **Base Sepolia milestones** | CDP Node RPC + CDP bundler/paymaster (Sepolia), the sponsorship policy draft, the address registry + extcodehash CI, a synthetic UserOp probe, the event watcher, the ZK Email relayer on Sepolia, the ETH reserve from the Sepolia faucet. **Measure real gas per operation.** | Review the measured costs and the internal-review checklist (§10.6). |
| **Later** | FCM / Play Integrity accounts, then staging secrets. Apple items once enrolment exists. | Create the Play Console / Firebase / Apple accounts. |
| **Deferred** | Production hosting, production secrets, mainnet. | A go-ahead after dev testing. |

---

## 9. Risks

1. **Staging only.** The laptop hosts everything (API, DB, mail). That's acceptable for dev testing and not for real users.
2. **No external audit (r6).** Smart-contract and integration risk rests on audited canonical components, zero custom on-chain code, and an internal review (§10.6).
3. **DMARC `reject` affects all `@vistablox.io` mail.** Switch only after the reports look clean.
4. **Apple enrolment lead time** (Track B).
5. **Play Integrity:** strong integrity at signing excludes some older phones.
6. **Rotating keys:** Google attestation roots, and email providers' DKIM keys in the ZK Email registry.
7. **Single provider (CDP)** for RPC, bundler and paymaster. An outage stops sponsored transactions. The public fallback + ETH reserve keep self-paid actions possible. Funds are never at risk.
8. **Server-side limits are bypassable via the fallback by design.** The on-chain limits guard is an open item.
9. **The ETH reserve is free ETH,** which invites farming. Fund it only after KYC approval, once per account, with a small amount (§10.3a).

---

## 10. Wallet infrastructure: Safe smart account on Base (Sepolia for now)

**The model (final backend/mobile plans):**
- a Safe with **ERC-4337 via `Safe4337Module` v0.3.0** (EntryPoint **v0.7** pinned), **threshold 1, ≤ 2 owners**;
- owners are device P-256 keys via Safe's passkey signer, verified through the P-256 precompile at `0x100`;
- **native Safe modules, no Safe7579** (⚠ confirm with Damir, §11);
- `SafeEmailRecoveryModule`: the user's mailbox as guardian, a 7-day delay, cancellable from any device;
- the public-bundler fallback after 7 days of VistaBlox being unreachable;
- after recovery: *view immediately, move money after 7 days*.

### 10.1 RPC: **CDP Node (Damir r6)**
- **Free tier:**
  - 10 M billing units/month, ≈ 300 k typical calls at ~30 BU per call;
  - rate limit ≈ 7,500 BU per 5 s per project, ≈ 50 req/s;
  - then $0.50 per million BU;
  - **a payment method on file is required since January 2026**, even on the free tier.
  - That comfortably covers staging.
- **Config:** `CHAIN_RPC_URLS` = [CDP Node (Base Sepolia now, Base later), public `sepolia.base.org` / `mainnet.base.org` as the last resort]. The app gets its own restricted key, or reads through the backend.

### 10.2 Bundler: **CDP, one provider, server-side**
- Self-hosting is out: a Base full node with `debug` tracing needs 2.5–4 TB+ of NVMe.
- The server relays every UserOp to CDP.
- **The app's public fallback:**
  - Pimlico public `https://public.pimlico.io/v2/{chainId}/rpc` (20 req/min/IP; sponsors on testnets only);
  - Candide public `https://api.candide.dev/public/v3/{network}`;
  - a user-configurable URL.
  - On mainnet, the fallback is self-paid from the Safe's ETH (§10.3a).
- **Monitoring:** an hourly synthetic UserOp on Base Sepolia.

### 10.3 Paymaster: **option A via CDP (decided)**
- **Role:** it pays the gas fee for users' wallet actions. It can only pay or refuse; it can never move funds.
- **VistaBlox spends on:**
  - Safe creation;
  - signed on-chain transactions;
  - device/recovery operations, with **`cancelRecovery()` always sponsored**.
- **Estimated mainnet cost:**
  - ≈ €0.01–0.05 per Safe creation;
  - ≈ €0.005–0.03 per transaction;
  - so for 1,000 users × 10 tx/month, ≈ €50–300/month, plus 7 %.
  - Measured Sepolia gas replaces these estimates.
- **Policy:**
  - an allowlist of platform contracts and selectors, generated from the pinned registry;
  - per-user daily and global monthly caps;
  - alerts at 50/80/100 %;
  - never an ERC-20 paymaster.

### 10.3a ETH reserve per wallet (**decided, r6**)
- **Purpose:** each Safe holds a small ETH balance, so the **public-bundler fallback (self-paid) always works**, even if VistaBlox and CDP are unreachable.
- **Amount:** ~€2–5 worth of ETH per Safe. At current prices that covers roughly 100+ self-paid operations, and the app shows the balance in the fallback path only.
- **Who funds it, and how:**
  - VistaBlox sends ETH **into** the user's Safe once, after KYC approval. It's a plain transfer. **VistaBlox gains no control over the Safe.**
  - The funding source is a **VistaBlox-owned reserve wallet** holding only VistaBlox's own ETH, so its key is **not** a key over any user wallet.
  - **Staging:** a Base Sepolia test wallet funded from a faucet (`ETH_RESERVE_FUNDER_*`, a test key only).
  - **Production (later):** a small hot funder wallet with a low balance and daily limits, topped up in batches from a VistaBlox multisig held on hardware keys. *Design to confirm before mainnet.*
- **Abuse control:** fund once per account, only after KYC approval, and never re-fund automatically. Top-ups after heavy fallback use are a support decision.
- **Alternatives considered:** the user funds the reserve themselves (friction, conflicting with "no crypto jargon"), or no reserve (the fallback fails for users without ETH, which breaks the 7-day guarantee).

### 10.4 ZK Email relayer (recovery)
- **What it does:**
  - sends the recovery command email;
  - receives the DKIM-signed reply (IMAP);
  - proves and submits it.
  - It can't forge a proof (`UserOverrideableDKIMRegistry`).
- **Setup:** self-host on **Base Sepolia** first. The mailbox `recovery@vistablox.io` lives on `vistablox-mail`; the prover and Postgres run on Coolify. The relayer's own submission gas comes from its own small ETH float (Sepolia faucet).
- **(V1, critical, auth-dev Phase 0):** can a *different* relayer process the same user's recovery? That decides whether email recovery survives VistaBlox being unreachable.
- **Contract facts:**
  - `cancelRecovery()` can only be called by the account; `cancelExpiredRecovery` is permissionless;
  - the minimum recovery window is 2 days, and expiry must exceed the delay (7-day delay, ~14-day expiry).
- **Monitoring:** relayer and prover health, and DKIM registry freshness for the major providers.

### 10.5 Deployment approach and address registry
- **Canonical deployments only:**
  - Safe v1.4.1 (singleton, proxy factory);
  - `Safe4337Module` v0.3.0;
  - Safe's passkey signer contracts (`SafeWebAuthnSignerFactory`, `SafeWebAuthnSharedSigner`, `SafeWebAuthnSignerProxy`);
  - `SafeEmailRecoveryModule` + `UserOverrideableDKIMRegistry`.
  - **No custom contracts. No Safe7579.**
- **Registry:** `docs/chain-addresses.md` + `SAFE_*` per network, with a CI `extcodehash` check against the canonical artifacts. The app refuses unknown modules, and the CDP allowlist is generated from the registry.
- **Eager deployment at the first enrolment, mechanism open (§11):**
  - **(a), recommended:** a **sponsored UserOp with `initCode`, signed by the enrolling device**, so there's no VistaBlox key and no ETH. Technical consequences (from mobile-dev):
    - **Device 1's owner must be `SafeWebAuthnSharedSigner`**, configured with the P-256 key during setup. A per-device signer proxy doesn't exist yet at first-UserOp validation, and ERC-7562 forbids calling undeployed code there.
    - **Later devices** get a per-device `SafeWebAuthnSignerProxy`: the add-owner UserOp batches `createSigner(x,y)` + `addOwnerWithThreshold` via `MultiSendCallOnly`.
    - **Re-adding device 1 after a biometric change:** deploy a new proxy + `swapOwner(sharedSigner → newProxy)`. The shared signer holds one key per Safe.
    - **Still one biometric prompt at enrolment:** a new step, **E1b**, sends the public key and returns the proposed deployment `user_op` with CDP `paymasterAndData`. One owner assertion over its `op_hash` (`vb_purpose: "enrol-device"`, `vb_challenge` = E1's challenge) proves possession of the key, a live biometric and deployment approval together.
  - **(b):** a direct factory call from a **VistaBlox deployer key** + an ETH float. No user signature, but a VistaBlox key and an ETH treasury. *Not recommended.*
  - If Damir picks (a), auth-dev and mobile-dev fold E1b, device 1's `owner_address` = the shared signer, and the `createSigner` batching into section 3.
- **P-256 signing:**
  - one WebAuthn-shaped owner assertion per on-chain action, via the audited Safe passkey signer, with no custom validator;
  - the verifier checks the challenge and flags, not the origin, so origin rests on App Attest / Play Integrity and the hardware biometric gate.

### 10.6 Audits: **no external audit budget (Damir, r6)**

| Component | Audit status | Action |
|---|---|---|
| Safe core v1.4.1 | Widely audited; canonical | Pin; bytecode-verify |
| `Safe4337Module` v0.3.0 | Audited with EntryPoint v0.7 (auditors: to verify) | Pin |
| Safe passkey signer (incl. `SafeWebAuthnSharedSigner`) v0.2.x | Audit reports for v0.2.0/v0.2.1 (auditors and Base deployment: to verify) | Pin; read the reports' findings |
| `SafeEmailRecoveryModule` | Ackee, July 2024, commit `4e70316`: 27 findings (**2 high**, 5 medium); remediation: **to verify**. Zellic report scope: to verify | **Must confirm the high findings are fixed in the pinned version** |
| `UserOverrideableDKIMRegistry` + verifier | To verify | Read what exists |
| Safe7579 | Not used | None |
| **Our integration** (initializer, recovery params, owner flows, envelope construction, sponsorship scope, deployment mechanism) | No external audit | **Internal review (below)** |

- **Without an audit budget, the safeguards are:**
  1. **Zero custom on-chain code.** Only canonical, audited, pinned, bytecode-verified contracts.
  2. **Read the existing audit reports** for every pinned component, and **verify remediation** (especially ZK Email's 2 high findings). auth-dev's Phase 0 owns the "to verify" cells.
  3. **An internal security review by Damir**, with a written checklist:
     - owner/threshold invariants;
     - the recovery delay, expiry and cancel paths;
     - no module or guard can be added without an owner;
     - the WebAuthn envelope and challenge binding;
     - the paymaster can't move funds;
     - no approvals to third parties;
     - the fallback path tested.
  4. **A Base Sepolia soak test** with adversarial cases (replay, purpose confusion, wrong device, relay-phishing recovery, a cancel during the delay).
  5. **Bounded exposure at mainnet start** (low value limits) when that comes; plus an optional bug bounty or audit contest once budget exists.
- **The mainnet gate is Damir's explicit sign-off** on 1–4. There's no mainnet now anyway (staging only).

### 10.7 On-chain monitoring (awareness only)
- The event watcher covers recovery requested/completed, owner and module changes, guard/fallback-handler changes, and large outflows. Each triggers an immediate push to all devices plus a security email.
- **Ops alerts:** DKIM registry updates, CDP cap thresholds, bundler probe failures, and low balances on the reserve funder and relayer.

---

## 11. Open questions for Damir

**Need a decision:**
1. **Confirm dropping Safe7579** (native Safe modules only), since the r2 wording said "ERC-4337 + ERC-7579". *Recommended: yes.*
2. **Safe deployment mechanism:** (a) a sponsored UserOp signed by the device (no VistaBlox key; one prompt via E1b) or (b) a VistaBlox deployer key. *Recommended: (a).*
3. **The DMARC/SPF switch:** once the reports look clean, a go-ahead to set `p=reject; sp=reject` and SPF `-all` (§2.3).
4. **Pairing hold** (from the backend/mobile plans): 0 h vs 24 h after pairing a new device.
5. **The on-chain limits guard** (from the backend/mobile plans): build an owner-controlled Safe guard, so limits also hold on the fallback path?

**Later (with data or when relevant):**
- sponsorship caps (after Sepolia gas measurement);
- the ZK Email relayer operator (after V1);
- the production ETH-reserve funder design;
- account ownership (Apple/Play/Firebase/CDP);
- production hosting.
