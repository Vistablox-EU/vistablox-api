import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.url().refine((value) => value.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a PostgreSQL URL",
    }),
    BETTER_AUTH_URL: z.url().default("http://localhost:3000"),
    BETTER_AUTH_SECRET: z.string().min(32),
    // Device binding (DPoP) is off entirely when unset. Set once, at the
    // actual phase-1 deploy moment, and never move it afterward -- it's the
    // one-time historical line between "this session predates proof-of-
    // possession and may bind to the first valid proof it sees" and "this
    // session was created after mobile could already send one, so seeing it
    // unbound now is an anomaly, not a migration case" (AD-device-binding).
    DPOP_PHASE1_CUTOVER_AT: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.date().optional(),
    ),
    WEBAUTHN_RP_NAME: z.string().min(1).default("VistaBlox"),
    // Pinned separately from BETTER_AUTH_URL on purpose (AD-device-binding
    // follow-up): every enrolled passkey (customer and staff) is bound to
    // this exact value, so moving BETTER_AUTH_URL must never silently
    // change it. Validated below against BETTER_AUTH_URL's hostname when
    // set -- see the .refine() near the bottom of this schema.
    WEBAUTHN_RP_ID: optionalHostname(),
    // Every web origin a WebAuthn ceremony may come from: comma-separated
    // exact origins (scheme://host[:port], no path, no wildcard). The rpId's
    // own origin is https://<WEBAUTHN_RP_ID>; any other entry (the admin
    // console, https://admin.vistablox.io) is a WebAuthn Related Origin and
    // is published at GET /.well-known/webauthn so browsers let it use the
    // pinned rpId. Unset falls back to BETTER_AUTH_URL's origin -- see
    // resolveWebAuthnOrigins below.
    WEBAUTHN_ORIGIN: z.preprocess(
      splitCommaSeparatedList,
      z
        .array(
          z.string().refine(isExactWebOrigin, {
            message:
              "each entry must be an exact origin -- https://host[:port] on a DNS name, no path, trailing slash or dot, port 0, IP address, or wildcard (localhost/loopback allowed for local development)",
          }),
        )
        .refine((origins) => new Set(origins).size === origins.length, {
          message: "WEBAUTHN_ORIGIN: duplicate entry",
        })
        .optional(),
    ),
    PASSKEY_APPLE_TEAM_ID: optionalNonEmptyString(),
    PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS: z.preprocess(
      emptyStringToUndefined,
      z.string().transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)).optional(),
    ),
    // Distinct from the fingerprints above (assetlinks.json/Digital Asset
    // Links): this is the WebAuthn *origin* string Android's Credential
    // Manager sends with a native passkey ceremony -- "android:apk-key-hash:
    // <base64url>" -- which @better-auth/passkey's origin allowlist must
    // match verbatim or every native registration/authentication fails with
    // "Unexpected registration response origin". One entry per signing key
    // (debug keystore, Play App Signing, etc.), same comma-separated style.
    PASSKEY_ANDROID_ORIGINS: z.preprocess(
      emptyStringToUndefined,
      z.string().transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)).optional(),
    ),
    STAFF_INVITATION_ACCEPT_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    STAFF_RECOVERY_REDIRECT_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    ACCOUNT_RECOVERY_REDIRECT_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    // Device-key auth: Android key attestation + Play Integrity policy.
    // "disabled" is an interim value for staging while there's no Play
    // Console/Cloud project yet -- it skips the Play Integrity token check
    // only; Android key attestation (chain, attestationChallenge match,
    // hardware-backed, cert-digest allowlist, revocation list) is always
    // enforced regardless of this value. "relaxed" additionally accepts
    // UNRECOGNIZED_VERSION (sideloaded builds) once the account exists;
    // "strict" is the eventual production policy. Refused in production
    // below except as "strict" -- see the .refine() near the bottom.
    // The deployment tier, kept separate from NODE_ENV because staging
    // deliberately runs NODE_ENV=production (secure cookies, production
    // builds; see the Dockerfile), so NODE_ENV alone can't tell staging from
    // production. Unset means production: a real production deploy stays
    // protected without anyone having to remember to set it.
    APP_ENV: z.preprocess(emptyStringToUndefined, z.enum(["staging", "production"]).optional()),
    PLAY_INTEGRITY_POLICY: z.enum(["disabled", "relaxed", "strict"]).default("disabled"),
    PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER: optionalNonEmptyString(),
    // Base64-encoded service account JSON, decode-only role, used to verify
    // (never mint) Play Integrity tokens.
    PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON: optionalNonEmptyString(),
    // The Android app-signing-cert allowlist for key attestation's leaf
    // certificate -- comma-separated SHA-256 digests, same shape as
    // PASSKEY_ANDROID_SHA256_CERT_FINGERPRINTS but kept as its own variable
    // since passkeys (and that variable) are going away.
    ANDROID_ATTESTATION_CERT_DIGESTS: z.preprocess(
      emptyStringToUndefined,
      z.string().transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)).optional(),
    ),
    // Google's published hardware-attestation root certificates
    // (source.android.com/docs/security/features/keystore/attestation),
    // base64 DER, comma-separated. Deliberately a config value, not a
    // hardcoded constant, so the set can be updated without a code deploy
    // if/when Google rotates it -- but there is no safe fallback if this is
    // left empty: verifyAndroidKeyAttestation refuses every chain outright
    // rather than silently accepting an unpinned one, so this must be set
    // before device enrolment can work anywhere, including staging.
    ANDROID_ATTESTATION_ROOT_CERTIFICATES: z.preprocess(
      emptyStringToUndefined,
      z.string().transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)).optional(),
    ),
    AUTH_TRUSTED_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
    GOOGLE_OAUTH_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    GOOGLE_CLIENT_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    GOOGLE_CLIENT_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    APPLE_OAUTH_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    APPLE_CLIENT_ID: optionalNonEmptyString(),
    APPLE_TEAM_ID: optionalNonEmptyString(),
    APPLE_KEY_ID: optionalNonEmptyString(),
    APPLE_PRIVATE_KEY: optionalNonEmptyString(),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USER: z.string().min(1),
    SMTP_PASSWORD: z.string().min(1),
    SMTP_FROM: z.string().min(1),
    RATE_LIMIT_CACHE_URL: z.preprocess(
      emptyStringToUndefined,
      z
        .url()
        .refine(
          (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
          { message: "RATE_LIMIT_CACHE_URL must be a Redis or TLS Redis URL" },
        )
        .optional(),
    ),
    // Best-effort display-profile cache invalidation/refresh on KYC state
    // changes, skipped (with a warning) when unset or unreachable rather
    // than failing webhook processing or the profile read.
    PROFILE_CACHE_URL: z.preprocess(
      emptyStringToUndefined,
      z
        .url()
        .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
          message: "PROFILE_CACHE_URL must be a Redis or TLS Redis URL",
        })
        .optional(),
    ),
    MINIO_ENDPOINT: optionalNonEmptyString(),
    MINIO_PORT: z.coerce.number().int().min(1).max(65_535).default(9_000),
    MINIO_USE_SSL: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MINIO_ACCESS_KEY: optionalNonEmptyString(),
    MINIO_SECRET_KEY: z.preprocess(
      emptyStringToUndefined,
      z.string().min(8).optional(),
    ),
    MINIO_DOCUMENT_BUCKET: z.preprocess(
      emptyStringToUndefined,
      z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).optional(),
    ),
    // Required outright, not optional-together -- there is no "KYC disabled"
    // mode: /v1/kyc's session creation, the Didit webhook, and account
    // recovery's own re-verification flow all reuse this one configuration
    // (account recovery "re-proves a live human with a valid ID," the exact
    // same check ordinary KYC does, not a separate provider setup). Merging
    // what used to be two independently-settable schemas (this file's own
    // optional-together trio, and src/config/kyc-environment.ts's required
    // copies, back when KYC was a standalone service) into one required set
    // also closes a real footgun: those two were supposed to always hold
    // identical values, and nothing enforced that.
    DIDIT_API_BASE_URL: z.url().default("https://verification.didit.me"),
    DIDIT_API_KEY: z.string().min(1),
    DIDIT_WORKFLOW_ID: z.string().uuid(),
    DIDIT_CALLBACK_URL: z.url(),
    DIDIT_WEBHOOK_SECRET: z.string().min(16),
    DIDIT_APPLICATION_ID: z.string().uuid(),
    DIDIT_ENVIRONMENT: z.enum(["sandbox", "live"]),
    // Optional separate hosted Address Verification workflow for owner
    // intake; must differ from DIDIT_WORKFLOW_ID when set (see the .refine()
    // below).
    DIDIT_POA_WORKFLOW_ID: optionalUuid(),
    COINBASE_CDP_API_BASE_URL: z.url().default("https://api.developer.coinbase.com"),
    COINBASE_CDP_PAY_HOSTED_URL: z.url().default("https://pay.coinbase.com/buy/select-asset"),
    COINBASE_CDP_API_KEY_ID: optionalUuid(),
    COINBASE_CDP_API_KEY_SECRET: optionalNonEmptyString(),
    COINBASE_ONRAMP_BLOCKCHAIN: z.string().min(1).default("base"),
    COINBASE_ONRAMP_REDIRECT_URL: z.preprocess(
      emptyStringToUndefined,
      z.url().optional(),
    ),
    // A human decision, not something this codebase can verify on its own
    // (AD-255's "Still Open" item: live confirmation Coinbase actually
    // supports EUR/Base for this account). Stays false until someone who has
    // done that verification deliberately sets it — see
    // docs/investor-offering.md's pre-launch checklist.
    RESERVATION_FUNDING_RAIL_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Dormant by default, matching AD-234's pattern for the settlement layer
    // itself: built and testable, but not wired to run automatically until
    // deliberately turned on. Built ahead of AD-232/AD-206's named trigger
    // (a real property nearing finalization) at the founder's direction.
    OPERATING_DISTRIBUTION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // Optional on-chain settlement integration (AD-163/AD-256): mint/burn on
    // the shared VistaBloxProperty contract and open/finalize IPO escrow
    // campaigns on VistaBloxIpoEscrow. Same "all together or none" shape as
    // the Coinbase CDP / Didit integrations above -- there is no deployed
    // contract address for any environment yet, so this simply doesn't run
    // until every value below is configured together.
    CHAIN_NETWORK: z.preprocess(
      emptyStringToUndefined,
      z.enum(["base", "base-sepolia"]).optional(),
    ),
    CHAIN_RPC_URL: z.preprocess(emptyStringToUndefined, z.url().optional()),
    CHAIN_OPERATOR_PRIVATE_KEY: z.preprocess(
      emptyStringToUndefined,
      z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "CHAIN_OPERATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key")
        .optional(),
    ),
    VISTABLOX_PROPERTY_CONTRACT_ADDRESS: optionalEthAddress(),
    VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS: optionalEthAddress(),
    EURC_TOKEN_ADDRESS: optionalEthAddress(),
    // A placeholder, single platform-wide destination for successful IPO
    // escrow sweeps until real per-PIV governed multisigs exist (a separate,
    // not-yet-designed piece of work) -- VistaBloxIpoEscrow.updateTreasury
    // exists specifically so this can be corrected per campaign once a real
    // multisig is provisioned, without redeploying anything.
    PIV_TREASURY_ADDRESS: optionalEthAddress(),
  })
  .refine(
    (environment) => {
      const values = [
        environment.MINIO_ENDPOINT,
        environment.MINIO_ACCESS_KEY,
        environment.MINIO_SECRET_KEY,
        environment.MINIO_DOCUMENT_BUCKET,
      ];
      return (
        values.every((value) => value === undefined) ||
        values.every((value) => value !== undefined)
      );
    },
    {
      message: "All MinIO document storage settings must be configured together",
      path: ["MINIO_ENDPOINT"],
    },
  )
  .refine(
    (environment) =>
      !environment.GOOGLE_OAUTH_ENABLED ||
      (environment.GOOGLE_CLIENT_ID !== undefined &&
        environment.GOOGLE_CLIENT_SECRET !== undefined),
    {
      message: "Google OAuth credentials are required when GOOGLE_OAUTH_ENABLED=true",
      path: ["GOOGLE_OAUTH_ENABLED"],
    },
  )
  .refine(
    (environment) => {
      const values = [
        environment.APPLE_CLIENT_ID,
        environment.APPLE_TEAM_ID,
        environment.APPLE_KEY_ID,
        environment.APPLE_PRIVATE_KEY,
      ];
      return (
        values.every((value) => value === undefined) ||
        values.every((value) => value !== undefined)
      );
    },
    {
      message: "All Apple OAuth settings must be configured together",
      path: ["APPLE_CLIENT_ID"],
    },
  )
  .refine(
    (environment) =>
      !environment.APPLE_OAUTH_ENABLED || environment.APPLE_CLIENT_ID !== undefined,
    {
      message: "Apple OAuth credentials are required when APPLE_OAUTH_ENABLED=true",
      path: ["APPLE_OAUTH_ENABLED"],
    },
  )
  .refine(
    (environment) =>
      (environment.GOOGLE_CLIENT_ID === undefined) ===
      (environment.GOOGLE_CLIENT_SECRET === undefined),
    {
      message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together",
      path: ["GOOGLE_CLIENT_ID"],
    },
  )
  .refine(
    (environment) =>
      environment.DIDIT_POA_WORKFLOW_ID === undefined ||
      environment.DIDIT_POA_WORKFLOW_ID !== environment.DIDIT_WORKFLOW_ID,
    {
      message: "DIDIT_POA_WORKFLOW_ID must differ from DIDIT_WORKFLOW_ID",
      path: ["DIDIT_POA_WORKFLOW_ID"],
    },
  )
  .refine(
    (environment) => {
      const values = [
        environment.COINBASE_CDP_API_KEY_ID,
        environment.COINBASE_CDP_API_KEY_SECRET,
        environment.COINBASE_ONRAMP_REDIRECT_URL,
      ];
      return (
        values.every((value) => value === undefined) ||
        values.every((value) => value !== undefined)
      );
    },
    {
      message: "All Coinbase CDP onramp settings must be configured together",
      path: ["COINBASE_CDP_API_KEY_ID"],
    },
  )
  .refine(
    (environment) => {
      const values = [
        environment.CHAIN_NETWORK,
        environment.CHAIN_RPC_URL,
        environment.CHAIN_OPERATOR_PRIVATE_KEY,
        environment.VISTABLOX_PROPERTY_CONTRACT_ADDRESS,
        environment.VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS,
        environment.EURC_TOKEN_ADDRESS,
        environment.PIV_TREASURY_ADDRESS,
      ];
      return (
        values.every((value) => value === undefined) ||
        values.every((value) => value !== undefined)
      );
    },
    {
      message: "All on-chain settlement settings must be configured together",
      path: ["CHAIN_NETWORK"],
    },
  )
  .refine(
    (environment) => {
      if (environment.WEBAUTHN_RP_ID === undefined) return true;
      const authHostname = new URL(environment.BETTER_AUTH_URL).hostname.toLowerCase();
      return (
        authHostname === environment.WEBAUTHN_RP_ID ||
        authHostname.endsWith(`.${environment.WEBAUTHN_RP_ID}`)
      );
    },
    {
      // The API serves the WebAuthn .well-known association files
      // (apple-app-site-association, assetlinks.json) itself, at
      // BETTER_AUTH_URL's own host -- that only works if this host is the
      // rpId or a subdomain of it.
      message: "BETTER_AUTH_URL's hostname must equal WEBAUTHN_RP_ID or be a subdomain of it",
      path: ["WEBAUTHN_RP_ID"],
    },
  )
  .refine(
    (environment) =>
      // A production build is a production deployment unless APP_ENV says
      // staging (staging runs NODE_ENV=production too).
      environment.NODE_ENV !== "production" ||
      environment.APP_ENV === "staging" ||
      environment.PLAY_INTEGRITY_POLICY === "strict",
    {
      message: "PLAY_INTEGRITY_POLICY must be \"strict\" in production -- \"disabled\" and \"relaxed\" exist for staging only",
      path: ["PLAY_INTEGRITY_POLICY"],
    },
  )
  .refine(
    (environment) =>
      (environment.ANDROID_ATTESTATION_CERT_DIGESTS ?? []).every(
        (digest) => normalizeHexDigest(digest).length === 64,
      ),
    {
      // Mirrors android-attestation-verifier.ts's own normalizeCertDigest
      // (strip non-hex, lowercase) -- a typo'd or truncated entry here would
      // otherwise surface much later as a silent, hard-to-diagnose
      // enrolment rejection instead of failing loudly at boot. Unset/empty
      // stays allowed, same as today: enrolment already refuses outright
      // with no digests configured (no fallback), so there's nothing extra
      // to catch here in that case.
      message:
        "ANDROID_ATTESTATION_CERT_DIGESTS: each entry must be a 64-character SHA-256 hex digest (colons and case are ignored)",
      path: ["ANDROID_ATTESTATION_CERT_DIGESTS"],
    },
  )
  .refine(
    (environment) =>
      environment.NODE_ENV !== "production" ||
      (environment.WEBAUTHN_ORIGIN ?? []).every(
        (origin) =>
          // Zod still runs object-level refines after a per-entry failure;
          // that entry is already reported, and new URL() could throw on it.
          !isExactWebOrigin(origin) ||
          (origin.startsWith("https://") && !LOOPBACK_HOSTNAMES.includes(new URL(origin).hostname)),
      ),
    {
      // Keyed on NODE_ENV, not APP_ENV: staging is a real https deployment
      // too, so there's no staging relaxation to carve out here.
      message:
        "WEBAUTHN_ORIGIN: every entry must be https in production, on a real host -- localhost/loopback is for local development only",
      path: ["WEBAUTHN_ORIGIN"],
    },
  )
  .refine(
    (environment) =>
      // Skipped when an entry or BETTER_AUTH_URL is already invalid: those
      // are reported on their own, and new URL() would throw on them here.
      !(environment.WEBAUTHN_ORIGIN ?? []).every(isExactWebOrigin) ||
      !URL.canParse(environment.BETTER_AUTH_URL) ||
      registrableLabels(resolveWebAuthnSettings(environment).relatedOrigins).size <=
        MAX_RELATED_ORIGIN_LABELS,
    {
      // WebAuthn Related Origin Requests: a browser stops reading
      // /.well-known/webauthn once it has seen maxLabels distinct
      // registrable-domain labels (clients must support at least 5, and none
      // is known to support more), so origins past that silently never work.
      message:
        "WEBAUTHN_ORIGIN: related origins span more than 5 distinct registrable-domain labels -- browsers ignore every origin past the fifth",
      path: ["WEBAUTHN_ORIGIN"],
    },
  );

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}

// Structural rather than Pick<Environment, ...>: the schema's own .refine()
// calls resolveWebAuthnSettings, so referencing Environment here would make
// the schema's inferred type circular.
interface WebAuthnEnvironment {
  WEBAUTHN_RP_ID?: string | undefined;
  WEBAUTHN_ORIGIN?: string[] | undefined;
  BETTER_AUTH_URL: string;
  PASSKEY_ANDROID_ORIGINS?: string[] | undefined;
}

export interface WebAuthnSettings {
  /**
   * better-auth's passkey plugin, on both auth instances: every accepted
   * origin. Passkeys are staff-only from all of them since the Phase 4
   * cutover: customers can't use a passkey from any origin, including the
   * related ones (the admin console) and the native app's.
   */
  passkey: { rpId: string; origins: string[] };
  /** The staff step-up ceremony at /internal/v1/auth/webauthn. */
  staffCeremony: { rpId: string; origins: string[] };
  /** Web origins that aren't the rpId's own host, served at /.well-known/webauthn. */
  relatedOrigins: string[];
}

/**
 * Everything server.ts hands the WebAuthn consumers, derived in one place
 * so the wiring itself is covered by tests. Web origins come from
 * WEBAUTHN_ORIGIN, or BETTER_AUTH_URL's own origin when that's unset (local
 * dev); an origin whose host is the rpId or a subdomain of it is the rpId's
 * own, anything else is a related origin.
 */
export function resolveWebAuthnSettings(environment: WebAuthnEnvironment): WebAuthnSettings {
  const rpId = environment.WEBAUTHN_RP_ID ?? new URL(environment.BETTER_AUTH_URL).hostname;
  const webOrigins = environment.WEBAUTHN_ORIGIN ?? [new URL(environment.BETTER_AUTH_URL).origin];
  const isOwnOrigin = (origin: string) => {
    const { hostname } = new URL(origin);
    return hostname === rpId || hostname.endsWith(`.${rpId}`);
  };
  const androidOrigins = environment.PASSKEY_ANDROID_ORIGINS ?? [];
  return {
    passkey: {
      rpId,
      origins: [...webOrigins, ...androidOrigins],
    },
    staffCeremony: { rpId, origins: webOrigins },
    relatedOrigins: webOrigins.filter((origin) => !isOwnOrigin(origin)),
  };
}

const MAX_RELATED_ORIGIN_LABELS = 5;
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

// The label a browser counts against maxLabels is the registrable domain's
// first label ("vistablox" for admin.vistablox.io). Approximated as the
// second-to-last DNS label: exact for single-part suffixes like .io or
// .com; a multi-part suffix (.co.uk) would need the Public Suffix List.
function registrableLabels(origins: string[]): Set<string> {
  return new Set(
    origins.map((origin) => {
      const labels = new URL(origin).hostname.split(".");
      return labels.at(-2) ?? labels[0] ?? origin;
    }),
  );
}

function emptyStringToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
}

// "a, b ,,c" -> ["a", "b", "c"]; empty or all-blank -> undefined, so an
// unset-but-present compose variable behaves exactly like an absent one.
function splitCommaSeparatedList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length === 0 ? undefined : items;
}

// WebAuthn compares clientDataJSON.origin to this list byte-for-byte, so an
// entry has to be the serialized origin itself: a trailing slash, path,
// default port, or uppercase host would never match anything. Wildcards
// are refused outright (URL parsing would otherwise accept "*" in a host).
// Loopback hosts (http or https) exist for local development only -- the
// production .refine() above refuses them; everything else must be https
// on a multi-label DNS name. A bare single label ("https://io") is refused
// as a cheap public-suffix guard; multi-part suffixes (co.uk) aren't
// detectable without the Public Suffix List.
function isExactWebOrigin(value: string): boolean {
  if (value.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value || url.port === "0") return false;
  const { hostname, protocol } = url;
  if (LOOPBACK_HOSTNAMES.includes(hostname)) return protocol === "http:" || protocol === "https:";
  if (protocol !== "https:") return false;
  if (hostname.endsWith(".")) return false;
  if (hostname.startsWith("[") || /^\d+(\.\d+){3}$/.test(hostname)) return false;
  return hostname.includes(".");
}

// Same rule as android-attestation-verifier.ts's normalizeCertDigest, kept
// as its own small copy rather than an import from src/modules/auth --
// config-loading runs before nearly everything else at boot and shouldn't
// pull in that module's own dependencies (x509/asn1 parsing, the
// reflect-metadata polyfill) just to validate a string shape.
function normalizeHexDigest(value: string): string {
  return value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
}

function optionalNonEmptyString() {
  return z.preprocess(emptyStringToUndefined, z.string().min(1).optional());
}

function optionalUuid() {
  return z.preprocess(emptyStringToUndefined, z.string().uuid().optional());
}

function optionalEthAddress() {
  return z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte address")
      .optional(),
  );
}

function optionalHostname() {
  return z.preprocess(
    emptyStringToUndefined,
    z
      .string()
      // A bare lowercase DNS hostname: no scheme, no port, no path, no
      // trailing dot. Each label 1-63 chars, alphanumeric plus hyphens,
      // not starting or ending with one, at least one label.
      .regex(
        /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
        "must be a bare lowercase hostname (no scheme, port, path, or trailing dot)",
      )
      .optional(),
  );
}
