// Pure decision for the transfer preflight (AD-267). The infrastructure layer
// reads one chain snapshot and simulates the exact calldata at that block;
// this function turns that snapshot into "ok" or the first reason the
// transfer would fail. Nothing here touches the chain, HTTP, or another layer.

export interface TransferRevert {
  // Solidity custom error name decoded from the revert data, or "Error" /
  // "Panic" for the built-in ones. Absent when the revert data was empty or
  // not decodable against the property contract's ABI.
  errorName?: string;
  // The Error(string) reason, when that is what the contract reverted with.
  reason?: string;
}

export type TransferSimulation =
  | { status: "passed" }
  | { status: "reverted"; revert: TransferRevert };

export interface TransferChainState {
  block: { number: bigint; hash: string };
  senderBalance: bigint;
  recipientAuthorized: boolean;
  tokenPaused: boolean;
  simulation: TransferSimulation;
}

export type TransferPreflightFailure =
  | "transfer_lane_closed"
  | "token_paused"
  | "recipient_not_authorized"
  | "insufficient_balance"
  | "recipient_cannot_receive"
  | "transfer_would_revert";

// Order matters: the first active reason wins. A closed lane is contract-wide
// and makes every request-specific reason moot (and is what the contract
// itself reports first, before any other check). paused > unauthorized >
// balance is the order this endpoint has always used.
const FAILURE_PRECEDENCE: readonly TransferPreflightFailure[] = [
  "transfer_lane_closed",
  "token_paused",
  "recipient_not_authorized",
  "insufficient_balance",
  "recipient_cannot_receive",
  "transfer_would_revert",
];

const REVERT_TO_FAILURE: Readonly<Record<string, TransferPreflightFailure>> = {
  TransferLaneClosed: "transfer_lane_closed",
  TokenIsPaused: "token_paused",
  EnforcedPause: "token_paused",
  HolderNotAuthorized: "recipient_not_authorized",
  ERC1155InsufficientBalance: "insufficient_balance",
  ERC1155InvalidReceiver: "recipient_cannot_receive",
};

function failureForRevert(revert: TransferRevert): TransferPreflightFailure {
  if (revert.errorName === undefined) {
    return "transfer_would_revert";
  }
  return Object.hasOwn(REVERT_TO_FAILURE, revert.errorName)
    ? (REVERT_TO_FAILURE[revert.errorName] as TransferPreflightFailure)
    : "transfer_would_revert";
}

export function assessTransferPreflight(input: {
  amount: bigint;
  state: TransferChainState;
}): TransferPreflightFailure | null {
  const { amount, state } = input;
  const active = new Set<TransferPreflightFailure>();

  if (state.tokenPaused) {
    active.add("token_paused");
  }
  if (!state.recipientAuthorized) {
    active.add("recipient_not_authorized");
  }
  if (amount > state.senderBalance) {
    active.add("insufficient_balance");
  }
  if (state.simulation.status === "reverted") {
    active.add(failureForRevert(state.simulation.revert));
  }

  for (const failure of FAILURE_PRECEDENCE) {
    if (active.has(failure)) {
      return failure;
    }
  }
  return null;
}
