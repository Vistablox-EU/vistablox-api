import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { z } from "zod";

const base64UrlSchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const transportsSchema = z.array(
  z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]),
);
const credentialBaseSchema = {
  id: base64UrlSchema,
  rawId: base64UrlSchema,
  type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
};

export const startRegistrationBodySchema = z.object({
  credential_label: z.string().trim().min(1).max(100).nullable().default(null),
});

export const finishRegistrationBodySchema = z.object({
  challenge_id: z.string().min(1),
  response: z
    .object({
      ...credentialBaseSchema,
      response: z.object({
        clientDataJSON: base64UrlSchema,
        attestationObject: base64UrlSchema,
        authenticatorData: base64UrlSchema.optional(),
        transports: transportsSchema.optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: base64UrlSchema.optional(),
      }),
    })
    .transform((value) => value as RegistrationResponseJSON),
});

export const finishAuthenticationBodySchema = z.object({
  challenge_id: z.string().min(1),
  response: z
    .object({
      ...credentialBaseSchema,
      response: z.object({
        clientDataJSON: base64UrlSchema,
        authenticatorData: base64UrlSchema,
        signature: base64UrlSchema,
        userHandle: base64UrlSchema.optional(),
      }),
    })
    .transform((value) => value as AuthenticationResponseJSON),
});

export const startCeremonyResponseSchema = z.object({
  data: z.object({
    challenge_id: z.string(),
    public_key: z.json(),
  }),
});

export const finishCeremonyResponseSchema = z.object({
  data: z.object({
    verified: z.literal(true),
    credential_id: z.string(),
    staff_mfa_verified: z.literal(true),
  }),
});
