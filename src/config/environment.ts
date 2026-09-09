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
    WEBAUTHN_RP_NAME: z.string().min(1).default("VistaBlox"),
    WEBAUTHN_RP_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    WEBAUTHN_ORIGIN: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
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
  );

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}

function emptyStringToUndefined(value: unknown): unknown {
  return value === "" ? undefined : value;
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
