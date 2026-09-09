import { z } from "zod";

// Deliberately separate from environment.ts's loadEnvironment: this service
// owns the whole KYC domain -- the Didit webhook, session creation/status
// and staff lookups, and (since the worker-jobs move) the renewal-reminder
// timer and stuck-session reconciliation too -- so its Didit settings are
// required outright rather than optional-together (there is no "KYC
// disabled" mode here: if this process is running, Didit must be
// configured), and it has none of the *un*related required vars
// (BETTER_AUTH_SECRET, OIDC_*, MinIO, etc.) the shared schema forces on
// every consumer today. SMTP_* is required here, unlike those -- the
// renewal-reminder email is this service's own responsibility now, the
// same way every other job in vistablox-worker already depends on the
// shared EmailSender interface while calling only its own one method.
const kycEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  DATABASE_URL: z.url().refine((value) => value.startsWith("postgresql://"), {
    message: "DATABASE_URL must be a PostgreSQL URL",
  }),
  DIDIT_API_BASE_URL: z.url().default("https://verification.didit.me"),
  DIDIT_API_KEY: z.string().min(1),
  DIDIT_WORKFLOW_ID: z.string().uuid(),
  DIDIT_POA_WORKFLOW_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().uuid().optional(),
  ),
  // Newly required as of the session-creation move -- StartKycSessionService/
  // StartProofOfAddressSessionService pass this straight to
  // DiditClient.createSession, same as vistablox-api's own copy of this var
  // does for account recovery's unrelated session-creation need.
  DIDIT_CALLBACK_URL: z.url(),
  DIDIT_WEBHOOK_SECRET: z.string().min(16),
  DIDIT_APPLICATION_ID: z.string().uuid(),
  DIDIT_ENVIRONMENT: z.enum(["sandbox", "live"]),
  // Verifies vistablox-api's internal calls (kyc-internal.router.ts) --
  // same value as vistablox-api's own INTERNAL_KYC_API_SECRET.
  INTERNAL_KYC_API_SECRET: z.string().min(32),
  // Newly required as of the worker-jobs move (Phase 5) --
  // RunKycRenewalTimerService sends the renewal-reminder email itself now,
  // matching environment.ts's own field definitions exactly.
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_FROM: z.string().min(1),
  // Optional, same as server.ts/worker.ts: best-effort display-profile cache
  // invalidation on KYC state changes, skipped (with a warning) when unset
  // or unreachable rather than failing webhook processing.
  PROFILE_CACHE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .url()
      .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
        message: "PROFILE_CACHE_URL must be a Redis or TLS Redis URL",
      })
      .optional(),
  ),
}).refine(
  (environment) =>
    environment.DIDIT_POA_WORKFLOW_ID === undefined ||
    environment.DIDIT_POA_WORKFLOW_ID !== environment.DIDIT_WORKFLOW_ID,
  {
    message: "DIDIT_POA_WORKFLOW_ID must differ from DIDIT_WORKFLOW_ID",
    path: ["DIDIT_POA_WORKFLOW_ID"],
  },
);

export type KycEnvironment = z.infer<typeof kycEnvironmentSchema>;

export function loadKycEnvironment(source: NodeJS.ProcessEnv = process.env): KycEnvironment {
  return kycEnvironmentSchema.parse(source);
}
