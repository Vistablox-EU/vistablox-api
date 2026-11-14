import { TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  ViemWalletRegistrationVerifier,
  WALLET_REGISTRATION_RECONCILE_CONFIRMATIONS,
} from "../src/infrastructure/blockchain/wallet-registration-verifier.js";
import type { WalletRegistryRpc } from "../src/infrastructure/blockchain/wallet-registry-chain-reader.js";
import { WALLET_REGISTRY_CONFIRMATION_DEPTH } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import { WalletRegistrationVerificationError } from "../src/modules/wallet/application/reconcile-wallet-registration.service.js";
import {
  COMMITMENT,
  EVENT_TIMESTAMP,
  OTHER_WALLET,
  REGISTRY,
  WALLET,
  hexHash,
  receipt,
  receiptLog,
} from "./support/wallet-registry-logs.js";

const TX = hexHash("bb");
const input = { txHash: TX, walletAddress: WALLET.toLowerCase(), commitment: COMMITMENT };

function verifierFor(overrides: Partial<WalletRegistryRpc>) {
  const rpc: WalletRegistryRpc = {
    getBlockNumber: vi.fn(async () => 110n),
    getBlock: vi.fn(async () => ({ hash: hexHash("aa") })),
    getTransactionReceipt: vi.fn(async () =>
      receipt({ blockNumber: 100n, logs: [receiptLog({ logIndex: 3, wallet: OTHER_WALLET }), receiptLog({ logIndex: 5 })] }),
    ),
    ...overrides,
  };
  return new ViemWalletRegistrationVerifier("base-sepolia", "http://127.0.0.1:1", REGISTRY, rpc);
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WalletRegistrationVerificationError);
    return (error as WalletRegistrationVerificationError).reason;
  }
  throw new Error("expected a verification error");
}

describe("ViemWalletRegistrationVerifier", () => {
  it("returns the event's identity, with the log index of this wallet's log, and the event's own timestamp", async () => {
    const result = await verifierFor({}).verify(input);

    expect(result).toEqual({
      transactionHash: TX,
      blockHash: hexHash("aa"),
      blockNumber: 100n,
      logIndex: 5,
      registeredAt: new Date(Number(EVENT_TIMESTAMP) * 1000),
    });
  });

  it("accepts a transaction exactly at the required depth and refuses one block short", async () => {
    const confirmations = WALLET_REGISTRATION_RECONCILE_CONFIRMATIONS;
    await expect(verifierFor({ getBlockNumber: vi.fn(async () => 100n + confirmations) }).verify(input)).resolves.toBeDefined();
    expect(await reasonOf(verifierFor({ getBlockNumber: vi.fn(async () => 100n + confirmations - 1n) }).verify(input))).toBe(
      "not_sufficiently_confirmed",
    );
  });

  it("requires the same depth the watcher waits for, so the two cannot drift apart", () => {
    expect(WALLET_REGISTRATION_RECONCILE_CONFIRMATIONS).toBe(WALLET_REGISTRY_CONFIRMATION_DEPTH);
  });

  it("reports an unknown transaction", async () => {
    const verifier = verifierFor({
      getTransactionReceipt: vi.fn(async () => {
        throw new TransactionReceiptNotFoundError({ hash: TX });
      }),
    });
    expect(await reasonOf(verifier.verify(input))).toBe("transaction_not_found");
  });

  it("reports a reverted transaction", async () => {
    const verifier = verifierFor({
      getTransactionReceipt: vi.fn(async () => receipt({ status: "reverted", logs: [receiptLog({ logIndex: 1 })] })),
    });
    expect(await reasonOf(verifier.verify(input))).toBe("transaction_reverted");
  });

  it("reports a transaction without this wallet's event, before it says anything about confirmations", async () => {
    const verifier = verifierFor({
      getTransactionReceipt: vi.fn(async () => receipt({ blockNumber: 109n, logs: [receiptLog({ logIndex: 1, wallet: OTHER_WALLET })] })),
    });
    expect(await reasonOf(verifier.verify(input))).toBe("event_not_found");
  });

  it.each([
    ["the receipt", { getTransactionReceipt: vi.fn(async () => { throw new Error("socket hang up"); }) }],
    ["the head block", { getBlockNumber: vi.fn(async () => { throw new Error("socket hang up"); }) }],
  ] as const)("reports a failing node as chain_unavailable, keeping the cause (%s)", async (_label, overrides) => {
    const verifier = verifierFor(overrides);
    let caught: unknown;
    try {
      await verifier.verify(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WalletRegistrationVerificationError);
    expect((caught as WalletRegistrationVerificationError).reason).toBe("chain_unavailable");
    expect(((caught as WalletRegistrationVerificationError).cause as Error).message).toBe("socket hang up");
  });
});
