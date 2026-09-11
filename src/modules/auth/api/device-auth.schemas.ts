import { z } from "zod";

export const appConfigResponseSchema = z.object({
  data: z.object({
    min_app_version: z.object({ ios: z.string(), android: z.string() }),
    features: z.object({
      device_auth: z.boolean(),
      device_enrolment_required: z.boolean(),
      passkey_login: z.boolean(),
      signing_requests: z.boolean(),
      recovery_v2: z.boolean(),
      safe_account: z.boolean(),
    }),
  }),
});

export const challengeResponseSchema = z.object({
  data: z.object({
    challenge: z.string(),
    expires_at: z.iso.datetime(),
  }),
});

export const loginChallengeResponseSchema = z.object({
  data: z.object({
    challenge: z.string(),
    expires_at: z.iso.datetime(),
    attestation_required: z.boolean(),
  }),
});

export const loginChallengeRequestSchema = z.object({
  device_id: z.string().min(1),
});

const androidAttestationRequestSchema = z.object({
  platform: z.literal("android"),
  key_attestation_chain: z.array(z.string()).min(1),
  integrity_token: z.string().optional(),
});

export const enrolVerifyRequestSchema = z.object({
  challenge: z.string().min(1),
  jws: z.string().min(1),
  attestation: androidAttestationRequestSchema,
});

export const enrolVerifyResponseSchema = z.object({
  data: z.object({
    device_id: z.string(),
    status: z.literal("active"),
    session_expires_at: z.iso.datetime(),
    authentication_level: z.literal("device_biometric"),
  }),
});

export const loginVerifyRequestSchema = z.object({
  device_id: z.string().min(1),
  challenge: z.string().min(1),
  jws: z.string().min(1),
});

export const loginVerifyResponseSchema = z.object({
  data: z.object({
    device_id: z.string(),
    session_expires_at: z.iso.datetime(),
    authentication_level: z.literal("device_biometric"),
  }),
});
