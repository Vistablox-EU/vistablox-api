import { z } from "zod";

const dateTime = z.iso.datetime();
// The zero address cannot send a transaction, so a wallet registered under it
// can never complete VistaBloxWalletRegistry.register() (the registry records
// msg.sender), and as a transfer destination it names no holder. It has no
// letters, so compare against the lowercase literal and leave the "0X"
// spelling to the shape check.
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ethAddress = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 20-byte, 0x-prefixed hex address")
  .refine((value) => value !== ZERO_ADDRESS, { message: "Must not be the zero address" });

export const registerWalletBodySchema = z.object({
  wallet_address: ethAddress,
});

export const registerWalletResponseSchema = z.object({
  data: z.object({
    wallet_address: z.string().min(1),
    registration_commitment: z.string().min(1),
    registry_contract_address: z.string().min(1),
    status: z.enum(["pending", "registered"]),
    requested_at: dateTime,
    registered_at: dateTime.nullable(),
  }),
});

export const getWalletStatusResponseSchema = z.object({
  data: z.object({
    wallet_address: z.string().min(1),
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

export const walletAccountIdParamsSchema = z.object({
  account_id: z.string().min(1),
});
export const reconcileWalletRegistrationBodySchema = z.object({
  // Stored and compared lower case, so the spelling staff typed does not matter.
  transaction_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((value) => value.toLowerCase()),
});
export const reconcileWalletRegistrationResponseSchema = z.object({
  data: z.object({
    account_id: z.string(),
    wallet_address: z.string(),
    status: z.literal("registered"),
    registration_tx_hash: z.string(),
    registration_block_number: z.string(),
    registration_block_hash: z.string(),
    registration_log_index: z.number().int(),
    // What the call did: confirmed a pending registration, filled in or
    // replaced the recorded evidence, or found the row already holding this event.
    outcome: z.enum(["confirmed", "evidence_recorded", "evidence_replaced", "unchanged"]),
    requested_at: dateTime,
    registered_at: dateTime,
  }),
});

// Staff-only view (admin_operations + staff WebAuthn, same gate as the
// equivalent KYC operations read) of the same wallet_registrations row the
// customer's own GET /v1/investor-profile/wallet reads from -- surfaces
// registration_commitment too, since a stuck "pending" registration is
// exactly the kind of thing a support ticket needs staff to see (whether the
// commitment ever reached the chain at all).
export const operationsWalletAccountResponseSchema = z.object({
  data: z.object({
    account_id: z.string().min(1),
    wallet_address: z.string().min(1),
    registration_commitment: z.string().min(1),
    status: z.enum(["pending", "registered"]),
    requested_at: dateTime,
    registered_at: dateTime.nullable(),
    // The on-chain event that confirmed the registration and what the job that
    // re-checks it has found. Staff only: a customer is never shown it.
    registration_evidence: z.object({
      status: z.enum(["none", "partial", "recorded", "verified", "flagged"]),
      transaction_hash: z.string().nullable(),
      block_number: z.string().nullable(),
      block_hash: z.string().nullable(),
      log_index: z.number().int().nullable(),
      verified_at: dateTime.nullable(),
      flag: z.enum(["transaction_missing", "transaction_reverted", "event_missing"]).nullable(),
      flagged_at: dateTime.nullable(),
    }),
  }),
});
