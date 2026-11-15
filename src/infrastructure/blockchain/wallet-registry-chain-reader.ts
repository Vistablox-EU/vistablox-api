import { BlockNotFoundError, TransactionReceiptNotFoundError, decodeEventLog, type Hex } from "viem";

import {
  normalizeChainHash,
  type WalletRegistrationEvidence,
} from "../../shared/domain/wallet-registration-evidence.js";
import abi from "./abis/VistaBloxWalletRegistry.abi.json" with { type: "json" };

interface ReceiptLog {
  address: string;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
}

interface Receipt {
  status: "success" | "reverted";
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  logs: readonly ReceiptLog[];
}

/** The slice of a viem public client this reader uses; the real client satisfies it as is. */
export interface WalletRegistryRpc {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null }>;
  getTransactionReceipt(args: { hash: Hex }): Promise<Receipt>;
}

export type RegistrationEventLookup =
  | {
      kind: "found";
      evidence: WalletRegistrationEvidence;
      /** The event's own timestamp argument (when the registry recorded the registration). */
      chainTimestamp: Date;
    }
  | { kind: "transaction_not_found" }
  | { kind: "transaction_reverted" }
  | { kind: "event_not_found" };

/**
 * Reads the chain for the one fact the registration evidence is about: which
 * block and log of which transaction carried the WalletRegistered event of a
 * given wallet and commitment.
 *
 * It answers with tagged results for what is a legitimate answer from the chain
 * (no receipt, a reverted receipt, no matching log) and lets an RPC failure
 * propagate, so a caller never mistakes "the node did not answer" for "the
 * event is gone".
 *
 * The same code serves the watcher's re-check and the staff reconcile, so both
 * record an event by the same identity: viem reports `logIndex` as the
 * block-wide index for logs from eth_getLogs and from receipts alike.
 */
export class WalletRegistryChainReader {
  public constructor(
    private readonly rpc: WalletRegistryRpc,
    private readonly registryAddress: string,
  ) {}

  /** The hash of the block currently at this height, or null when the node has no such block. */
  public async getCanonicalBlockHash(blockNumber: bigint): Promise<string | null> {
    try {
      const block = await this.rpc.getBlock({ blockNumber });
      return block.hash === null ? null : normalizeChainHash(block.hash);
    } catch (error) {
      if (isNamed(error, BlockNotFoundError, "BlockNotFoundError")) return null;
      throw error;
    }
  }

  /**
   * The first WalletRegistered log of the registry in this transaction whose
   * wallet and commitment match. A transaction can hold several (a bundler
   * relaying several registrations), so a log of another wallet is skipped, not
   * an error.
   */
  public async findRegistrationEvent(input: {
    transactionHash: string;
    walletAddress: string;
    commitment: string;
  }): Promise<RegistrationEventLookup> {
    let receipt: Receipt;
    try {
      receipt = await this.rpc.getTransactionReceipt({ hash: normalizeChainHash(input.transactionHash) as Hex });
    } catch (error) {
      if (isNamed(error, TransactionReceiptNotFoundError, "TransactionReceiptNotFoundError")) {
        return { kind: "transaction_not_found" };
      }
      throw error;
    }
    if (receipt.status !== "success") return { kind: "transaction_reverted" };

    const registry = this.registryAddress.toLowerCase();
    const wallet = input.walletAddress.toLowerCase();
    const commitment = input.commitment.toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== registry) continue;
      if (log.logIndex === null) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi, data: log.data, topics: [...log.topics] as [Hex, ...Hex[]] });
      } catch {
        continue; // a log of the registry that is not one of its known events
      }
      if (decoded.eventName !== "WalletRegistered") continue;
      const args = decoded.args as unknown as { wallet: string; commitment: string; timestamp: bigint };
      if (args.wallet.toLowerCase() !== wallet || args.commitment.toLowerCase() !== commitment) continue;
      return {
        kind: "found",
        evidence: {
          transactionHash: normalizeChainHash(receipt.transactionHash),
          blockHash: normalizeChainHash(receipt.blockHash),
          blockNumber: receipt.blockNumber,
          logIndex: log.logIndex,
        },
        chainTimestamp: new Date(Number(args.timestamp) * 1000),
      };
    }
    return { kind: "event_not_found" };
  }
}

// viem's own error classes, matched by identity first and by name second so a
// copy of viem loaded twice (or an error rebuilt by a wrapper) is still recognized.
function isNamed(error: unknown, errorClass: new (...args: never[]) => Error, name: string): boolean {
  return error instanceof errorClass || (error instanceof Error && error.name === name);
}
