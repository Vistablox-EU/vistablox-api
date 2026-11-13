import {
  BaseError,
  ExecutionRevertedError,
  decodeErrorResult,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import type { base, baseSepolia } from "viem/chains";

import type {
  TransferChainState,
  TransferRevert,
  TransferSimulation,
} from "../../modules/wallet/domain/transfer-preflight-policy.js";
import { ChainStateUnavailableError } from "../../shared/errors/chain-state-unavailable-error.js";
import vistaBloxPropertyAbi from "./abis/VistaBloxProperty.abi.json" with { type: "json" };

// The property contract's own custom errors plus the two built-ins a revert
// can carry, so a revert decodes whether it came from the contract, from
// OpenZeppelin, or from a receiver hook.
const revertAbi = [
  ...vistaBloxPropertyAbi,
  ...parseAbi(["error Error(string message)", "error Panic(uint256 code)"]),
] as const;

// viem's http transport retries three times with a 10 s timeout each, so two
// sequential rounds could otherwise hold a request open for over a minute.
export const TRANSFER_SNAPSHOT_BUDGET_MS = 10_000;

type SnapshotClient = PublicClient<Transport, typeof base | typeof baseSepolia>;

export interface TransferSnapshotDeps {
  client: SnapshotClient;
  propertyAddress: Address;
  chainId: number;
  encodeTransferCalldata(input: {
    from: Address;
    to: Address;
    tokenId: bigint;
    amount: bigint;
  }): Hex;
  budgetMs?: number;
}

export interface TransferSnapshotInput {
  from: string;
  to: string;
  tokenId: string;
  amount: string;
}

export interface TransferSnapshot extends TransferChainState {
  unsignedTransaction: { chainId: number; to: string; data: string; value: string };
}

/**
 * Reads everything the transfer preflight needs at ONE block and simulates
 * the exact calldata that will be returned at that same block (AD-267).
 *
 * 1. Read the head once with getBlock (uncached: viem caches getBlockNumber
 *    per client, which would let two requests share a "head").
 * 2. Pin both calls to that block's HASH with requireCanonical (EIP-1898), so
 *    a load-balanced RPC cannot answer from another block and a reorged head
 *    fails instead of mixing forks.
 * 3. One Multicall3 eth_call reads balance, recipient authorization and token
 *    pause; one eth_call simulates the transfer with from = the sender.
 *
 * Read-only and keyless: nothing is signed or broadcast (AD-240). The result
 * is advisory; the contract stays the final authority.
 */
export async function readTransferSnapshot(
  deps: TransferSnapshotDeps,
  input: TransferSnapshotInput,
): Promise<TransferSnapshot> {
  // viem rejects all-uppercase and bad-checksum mixed-case addresses, which
  // older rows can still hold; lowercase is always accepted. Only the values
  // sent to viem are lowercased, the response keeps what is stored.
  const from = input.from.trim().toLowerCase() as Address;
  const to = input.to.trim().toLowerCase() as Address;
  const tokenId = BigInt(input.tokenId);
  const amount = BigInt(input.amount);
  // Encoded once: these exact bytes are simulated and returned.
  const data = deps.encodeTransferCalldata({ from, to, tokenId, amount });

  const work = async (): Promise<TransferSnapshot> => {
    const head = await deps.client.getBlock({ blockTag: "latest" });
    if (head.number === null || head.hash === null) {
      throw new Error("latest block has no number or hash");
    }
    const pin = { blockHash: head.hash, requireCanonical: true } as const;
    const [reads, simulation] = await Promise.all([
      deps.client.multicall({
        allowFailure: false,
        batchSize: 0,
        ...pin,
        contracts: [
          {
            address: deps.propertyAddress,
            abi: vistaBloxPropertyAbi,
            functionName: "balanceOf",
            args: [from, tokenId],
          },
          {
            address: deps.propertyAddress,
            abi: vistaBloxPropertyAbi,
            functionName: "isHolderAuthorized",
            args: [to, tokenId],
          },
          {
            address: deps.propertyAddress,
            abi: vistaBloxPropertyAbi,
            functionName: "isTokenPaused",
            args: [tokenId],
          },
        ],
      }) as Promise<readonly [bigint, boolean, boolean]>,
      simulateTransfer(deps, { from, data, pin }),
    ]);
    const [senderBalance, recipientAuthorized, tokenPaused] = reads;
    return {
      block: { number: head.number, hash: head.hash },
      senderBalance,
      recipientAuthorized,
      tokenPaused,
      simulation,
      unsignedTransaction: {
        chainId: deps.chainId,
        to: deps.propertyAddress,
        data,
        value: "0",
      },
    };
  };

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ChainStateUnavailableError("chain state read timed out")),
      deps.budgetMs ?? TRANSFER_SNAPSHOT_BUDGET_MS,
    );
  });
  const attempt = work();
  // If the deadline wins, the abandoned attempt may still reject later.
  attempt.catch(() => undefined);
  try {
    return await Promise.race([attempt, deadline]);
  } catch (error) {
    throw error instanceof ChainStateUnavailableError
      ? error
      : new ChainStateUnavailableError(describe(error));
  } finally {
    clearTimeout(timer);
  }
}

async function simulateTransfer(
  deps: TransferSnapshotDeps,
  call: { from: Address; data: Hex; pin: { blockHash: Hex; requireCanonical: true } },
): Promise<TransferSimulation> {
  try {
    await deps.client.call({
      account: call.from,
      to: deps.propertyAddress,
      data: call.data,
      ...call.pin,
    });
    return { status: "passed" };
  } catch (error) {
    const revert = classifyRevert(error);
    if (revert === undefined) {
      throw error;
    }
    return { status: "reverted", revert };
  }
}

/**
 * An eth_call that the EVM rejected is an answer ("the transfer would
 * revert"); anything else (RPC error, timeout, unknown block, a JSON-RPC
 * -32603 internal error) is an outage and must not be reported to the
 * investor as a contract rejection. Deliberately not simulateContract:
 * viem's getContractError reports -32603 as a contract revert.
 */
export function classifyRevert(error: unknown): TransferRevert | undefined {
  if (
    !(error instanceof BaseError) ||
    error.walk((candidate) => candidate instanceof ExecutionRevertedError) === null
  ) {
    return undefined;
  }
  const root = error.walk() as { data?: unknown };
  const raw =
    typeof root.data === "object" && root.data !== null
      ? (root.data as { data?: unknown }).data
      : root.data;
  if (typeof raw !== "string" || raw.length < 10) {
    return {};
  }
  try {
    const decoded = decodeErrorResult({ abi: revertAbi, data: raw as Hex });
    return {
      errorName: decoded.errorName,
      ...(decoded.errorName === "Error"
        ? { reason: String((decoded.args as readonly unknown[] | undefined)?.[0]) }
        : {}),
    };
  } catch {
    return {};
  }
}

function describe(error: unknown): string {
  if (error instanceof BaseError) {
    return `${error.name}: ${error.shortMessage}`;
  }
  if (error instanceof Error) {
    return error.name;
  }
  return "unknown error";
}
