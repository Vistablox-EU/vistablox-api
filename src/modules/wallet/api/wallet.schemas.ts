import { z } from "zod";

const dateTime = z.iso.datetime();

export const registerWalletBodySchema = z.object({
  wallet_address: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 20-byte, 0x-prefixed hex address"),
});

export const registerWalletResponseSchema = z.object({
  data: z.object({
    wallet_address: z.string().min(1),
    registration_commitment: z.string().min(1),
    status: z.enum(["pending", "registered"]),
    requested_at: dateTime,
    registered_at: dateTime.nullable(),
  }),
});

export const getWalletBalanceResponseSchema = z.object({
  data: z.object({
    wallet_address: z.string().min(1),
    capital_eurc: z.string().min(1),
    tokens: z.array(
      z.object({
        piv_id: z.string().min(1),
        token_id: z.string().min(1),
        balance: z.string().min(1),
      }),
    ),
  }),
});
