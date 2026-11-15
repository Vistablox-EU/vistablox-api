import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";

import abi from "../../src/infrastructure/blockchain/abis/VistaBloxWalletRegistry.abi.json" with { type: "json" };

// Builders for WalletRegistered logs as a node returns them, shared by the
// chain reader, the verifier and the stub-node tests.

export const REGISTRY = `0x${"e".repeat(40)}` as Hex;
export const WALLET = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" as Hex;
export const OTHER_WALLET = `0x${"12".repeat(20)}` as Hex;
export const COMMITMENT = `0x${"ab".repeat(32)}` as Hex;
export const EVENT_TIMESTAMP = 1_700_000_000n;

export const hexHash = (byte: string): Hex => `0x${byte.repeat(32)}` as Hex;

export function registeredTopics(wallet: Hex, commitment: Hex): readonly Hex[] {
  return encodeEventTopics({ abi, eventName: "WalletRegistered", args: { wallet, commitment } }) as readonly Hex[];
}

export function registeredData(timestamp: bigint = EVENT_TIMESTAMP): Hex {
  return encodeAbiParameters([{ type: "uint256" }], [timestamp]);
}

/** A raw JSON-RPC log (hex quantities), as eth_getLogs returns it. */
export function rawLog(options: {
  logIndex: number;
  blockNumber?: number;
  blockHash?: string;
  transactionHash?: string;
  wallet?: Hex;
  commitment?: Hex;
  address?: string;
  removed?: boolean;
}) {
  return {
    address: options.address ?? REGISTRY,
    topics: registeredTopics(options.wallet ?? WALLET, options.commitment ?? COMMITMENT),
    data: registeredData(),
    blockHash: options.blockHash ?? hexHash("aa"),
    blockNumber: `0x${(options.blockNumber ?? 100).toString(16)}`,
    transactionHash: options.transactionHash ?? hexHash("bb"),
    transactionIndex: "0x1",
    logIndex: `0x${options.logIndex.toString(16)}`,
    removed: options.removed ?? false,
  };
}

/** A decoded (viem-shaped) receipt log, as getTransactionReceipt returns it. */
export function receiptLog(options: {
  logIndex: number | null;
  wallet?: Hex;
  commitment?: Hex;
  address?: string;
  topics?: readonly Hex[];
  data?: Hex;
}) {
  return {
    address: options.address ?? REGISTRY,
    topics: options.topics ?? registeredTopics(options.wallet ?? WALLET, options.commitment ?? COMMITMENT),
    data: options.data ?? registeredData(),
    logIndex: options.logIndex,
  };
}

export function receipt(options: {
  logs: ReadonlyArray<ReturnType<typeof receiptLog>>;
  status?: "success" | "reverted";
  blockHash?: string;
  blockNumber?: bigint;
  transactionHash?: string;
}) {
  return {
    status: options.status ?? ("success" as const),
    transactionHash: (options.transactionHash ?? hexHash("bb")) as Hex,
    blockHash: (options.blockHash ?? hexHash("aa")) as Hex,
    blockNumber: options.blockNumber ?? 100n,
    logs: options.logs,
  };
}

export function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
