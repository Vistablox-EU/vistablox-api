import { vi } from "vitest";

import type {
  UnsignedTransferTransaction,
  WalletTransferChainReader,
} from "../../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { TransferChainState } from "../../src/modules/wallet/domain/transfer-preflight-policy.js";

export type PassingTransferSnapshot = TransferChainState & {
  unsignedTransaction: UnsignedTransferTransaction;
};

export const SNAPSHOT_BLOCK_HASH = `0x${"ab".repeat(32)}`;

/**
 * A snapshot every check passes against: balance 10, recipient authorized,
 * token not paused, simulation passed. Override only what a test is about.
 */
export function buildPassingSnapshot(
  overrides: Partial<PassingTransferSnapshot> = {},
): PassingTransferSnapshot {
  return {
    block: { number: 123456n, hash: SNAPSHOT_BLOCK_HASH },
    senderBalance: 10n,
    recipientAuthorized: true,
    tokenPaused: false,
    simulation: { status: "passed" },
    unsignedTransaction: {
      chainId: 84532,
      to: "0xproperty",
      data: "0xdeadbeef",
      value: "0",
    },
    ...overrides,
  };
}

/**
 * The transfer service's only chain dependency is one snapshot method. Pass a
 * snapshot to resolve with it, or a full replacement for readTransferSnapshot.
 */
export function buildTransferChainReader(
  snapshot: PassingTransferSnapshot | WalletTransferChainReader["readTransferSnapshot"] = buildPassingSnapshot(),
): WalletTransferChainReader & {
  readTransferSnapshot: ReturnType<typeof vi.fn<WalletTransferChainReader["readTransferSnapshot"]>>;
} {
  const readTransferSnapshot = vi.fn<WalletTransferChainReader["readTransferSnapshot"]>(
    typeof snapshot === "function" ? snapshot : () => Promise.resolve(snapshot),
  );
  return { readTransferSnapshot };
}
