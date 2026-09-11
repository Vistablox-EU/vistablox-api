import { z } from "zod";

const androidAttestationSchema = z.object({
  platform: z.literal("android"),
  key_attestation_chain: z.array(z.string()).min(1),
  integrity_token: z.string().optional(),
});

const iosAttestationSchema = z.object({
  platform: z.literal("ios"),
  app_attest_key_id: z.string().min(1),
  attestation_object: z.string().min(1).optional(),
  assertion: z.string().min(1).optional(),
});

export const mobileAttestationSchema = z.discriminatedUnion("platform", [
  androidAttestationSchema,
  iosAttestationSchema,
]);

export type MobileAttestation = z.infer<typeof mobileAttestationSchema>;
