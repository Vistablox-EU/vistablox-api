import { z } from "zod";

const dateTime = z.iso.datetime();
const ethAddress = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 20-byte, 0x-prefixed hex address");

export const registerWalletBodySchema = z.object({
  wallet_address: ethAddress,
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

export const requestWalletTransferBodySchema = z.object({
  piv_id: z.string().min(1),
  to_wallet_address: ethAddress,
  amount: z.string().regex(/^[1-9][0-9]*$/, "Must be a positive integer amount"),
});

export const requestWalletTransferResponseSchema = z.object({
  data: z.object({
    piv_id: z.string().min(1),
    token_id: z.string().min(1),
    amount: z.string().min(1),
    from_wallet_address: z.string().min(1),
    to_wallet_address: z.string().min(1),
    unsigned_transaction: z.object({
      chain_id: z.number(),
      to: z.string().min(1),
      data: z.string().min(1),
      value: z.string().min(1),
    }),
  }),
});
