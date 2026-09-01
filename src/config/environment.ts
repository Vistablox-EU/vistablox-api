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
    STAFF_INVITATION_ACCEPT_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    STAFF_RECOVERY_REDIRECT_URL: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.url().optional(),
    ),
    AUTH_TRUSTED_ORIGINS: z
      .string()
      .default("http://localhost:3000")
      .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
    GOOGLE_CLIENT_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    GOOGLE_CLIENT_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().min(1).optional(),
    ),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USER: z.string().min(1),
    SMTP_PASSWORD: z.string().min(1),
    SMTP_FROM: z.string().min(1),
    DIDIT_API_BASE_URL: z.url().default("https://verification.didit.me"),
    DIDIT_API_KEY: optionalNonEmptyString(),
    DIDIT_WORKFLOW_ID: optionalUuid(),
    DIDIT_POA_WORKFLOW_ID: optionalUuid(),
    DIDIT_CALLBACK_URL: z.preprocess(
      emptyStringToUndefined,
      z.url().optional(),
    ),
    DIDIT_WEBHOOK_SECRET: z.preprocess(
      emptyStringToUndefined,
      z.string().min(16).optional(),
    ),
    DIDIT_APPLICATION_ID: optionalUuid(),
    DIDIT_ENVIRONMENT: z.preprocess(
      emptyStringToUndefined,
      z.enum(["sandbox", "live"]).optional(),
    ),
  })
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
    (environment) => {
      const values = [
        environment.DIDIT_API_KEY,
        environment.DIDIT_WORKFLOW_ID,
        environment.DIDIT_CALLBACK_URL,
        environment.DIDIT_WEBHOOK_SECRET,
        environment.DIDIT_APPLICATION_ID,
        environment.DIDIT_ENVIRONMENT,
      ];
      return (
        values.every((value) => value === undefined) ||
        values.every((value) => value !== undefined)
      );
    },
    {
      message: "All Didit KYC settings must be configured together",
      path: ["DIDIT_API_KEY"],
    },
  )
  .refine(
    (environment) =>
      environment.DIDIT_POA_WORKFLOW_ID === undefined ||
      environment.DIDIT_API_KEY !== undefined,
    {
      message: "DIDIT_POA_WORKFLOW_ID requires the Didit KYC integration",
      path: ["DIDIT_POA_WORKFLOW_ID"],
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
