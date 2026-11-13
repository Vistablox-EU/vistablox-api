import { BlockNotFoundError, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  WalletRegistryChainReader,
  type WalletRegistryRpc,
} from "../src/infrastructure/blockchain/wallet-registry-chain-reader.js";
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
const lookupInput = { transactionHash: TX, walletAddress: WALLET, commitment: COMMITMENT };

function readerFor(overrides: Partial<WalletRegistryRpc>) {
  const rpc: WalletRegistryRpc = {
    getBlockNumber: vi.fn(async () => 1000n),
    getBlock: vi.fn(async () => ({ hash: hexHash("aa") })),
    getTransactionReceipt: vi.fn(async () => receipt({ logs: [receiptLog({ logIndex: 4 })] })),
    ...overrides,
  };
  return { reader: new WalletRegistryChainReader(rpc, REGISTRY), rpc };
}

describe("WalletRegistryChainReader.findRegistrationEvent", () => {
  it("returns the block-wide log index and the receipt's block hash of the matching log", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () =>
        receipt({
          blockHash: hexHash("aa"),
          blockNumber: 321n,
          logs: [
            receiptLog({ logIndex: 3, wallet: OTHER_WALLET }),
            receiptLog({ logIndex: 5 }),
          ],
        }),
      ),
    });

    const result = await reader.findRegistrationEvent(lookupInput);

    expect(result).toEqual({
      kind: "found",
      evidence: { transactionHash: TX, blockHash: hexHash("aa"), blockNumber: 321n, logIndex: 5 },
      chainTimestamp: new Date(Number(EVENT_TIMESTAMP) * 1000),
    });
  });

  it("takes the first log when two match", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () =>
        receipt({ logs: [receiptLog({ logIndex: 7 }), receiptLog({ logIndex: 9 })] }),
      ),
    });

    const result = await reader.findRegistrationEvent(lookupInput);

    expect(result).toMatchObject({ kind: "found", evidence: { logIndex: 7 } });
  });

  it("ignores a log emitted by another contract", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () =>
        receipt({
          logs: [receiptLog({ logIndex: 1, address: `0x${"9".repeat(40)}` }), receiptLog({ logIndex: 2 })],
        }),
      ),
    });

    const result = await reader.findRegistrationEvent(lookupInput);

    expect(result).toMatchObject({ kind: "found", evidence: { logIndex: 2 } });
  });

  it("ignores a log of the registry that is not a decodable event", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () =>
        receipt({
          logs: [receiptLog({ logIndex: 1, topics: [hexHash("77")], data: "0x" }), receiptLog({ logIndex: 2 })],
        }),
      ),
    });

    const result = await reader.findRegistrationEvent(lookupInput);

    expect(result).toMatchObject({ kind: "found", evidence: { logIndex: 2 } });
  });

  it("matches wallet, commitment and registry address without regard to case, and lower-cases hashes", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () =>
        receipt({
          transactionHash: `0x${"BB".repeat(32)}`,
          blockHash: `0x${"AA".repeat(32)}`,
          logs: [receiptLog({ logIndex: 6, address: REGISTRY.toUpperCase().replace("0X", "0x") })],
        }),
      ),
    });

    const result = await reader.findRegistrationEvent({
      transactionHash: `0x${"BB".repeat(32)}`,
      walletAddress: WALLET.toLowerCase(),
      commitment: COMMITMENT.toUpperCase().replace("0X", "0x"),
    });

    expect(result).toMatchObject({
      kind: "found",
      evidence: { transactionHash: hexHash("bb"), blockHash: hexHash("aa"), logIndex: 6 },
    });
  });

  it("asks the node for the lower-cased hash", async () => {
    const { reader, rpc } = readerFor({});

    await reader.findRegistrationEvent({ ...lookupInput, transactionHash: `0x${"BB".repeat(32)}` });

    expect(rpc.getTransactionReceipt).toHaveBeenCalledWith({ hash: hexHash("bb") });
  });

  it("reports a reverted transaction", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () => receipt({ status: "reverted", logs: [receiptLog({ logIndex: 1 })] })),
    });
    expect(await reader.findRegistrationEvent(lookupInput)).toEqual({ kind: "transaction_reverted" });
  });

  it("reports a transaction the node does not know", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () => {
        throw new TransactionReceiptNotFoundError({ hash: TX });
      }),
    });
    expect(await reader.findRegistrationEvent(lookupInput)).toEqual({ kind: "transaction_not_found" });
  });

  it("reports a transaction without a matching log", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () =>
        receipt({ logs: [receiptLog({ logIndex: 1, wallet: OTHER_WALLET }), receiptLog({ logIndex: 2, commitment: hexHash("cc") })] }),
      ),
    });
    expect(await reader.findRegistrationEvent(lookupInput)).toEqual({ kind: "event_not_found" });
  });

  it("lets an RPC failure propagate instead of reading it as a missing event", async () => {
    const { reader } = readerFor({
      getTransactionReceipt: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    await expect(reader.findRegistrationEvent(lookupInput)).rejects.toThrow("rpc down");
  });
});

describe("WalletRegistryChainReader.getCanonicalBlockHash", () => {
  it("returns the lower-cased hash of the block at that height", async () => {
    const { reader, rpc } = readerFor({ getBlock: vi.fn(async () => ({ hash: `0x${"AB".repeat(32)}` as `0x${string}` })) });
    expect(await reader.getCanonicalBlockHash(55n)).toBe(hexHash("ab"));
    expect(rpc.getBlock).toHaveBeenCalledWith({ blockNumber: 55n });
  });

  it("returns null when the node has no such block", async () => {
    const { reader } = readerFor({
      getBlock: vi.fn(async () => {
        throw new BlockNotFoundError({ blockNumber: 55n });
      }),
    });
    expect(await reader.getCanonicalBlockHash(55n)).toBeNull();
  });

  it("returns null for a block without a hash", async () => {
    const { reader } = readerFor({ getBlock: vi.fn(async () => ({ hash: null })) });
    expect(await reader.getCanonicalBlockHash(55n)).toBeNull();
  });

  it("lets an RPC failure propagate", async () => {
    const { reader } = readerFor({
      getBlock: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });
    await expect(reader.getCanonicalBlockHash(55n)).rejects.toThrow("rpc down");
  });
});
