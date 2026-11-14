import { describe, expect, it } from "vitest";

import {
  assessTransferPreflight,
  type TransferChainState,
  type TransferPreflightFailure,
  type TransferSimulation,
} from "../src/modules/wallet/domain/transfer-preflight-policy.js";

function state(overrides: Partial<TransferChainState> = {}): TransferChainState {
  return {
    block: { number: 1n, hash: `0x${"11".repeat(32)}` },
    senderBalance: 10n,
    recipientAuthorized: true,
    tokenPaused: false,
    simulation: { status: "passed" },
    ...overrides,
  };
}

function reverted(errorName?: string): TransferSimulation {
  return { status: "reverted", revert: errorName === undefined ? {} : { errorName } };
}

describe("assessTransferPreflight", () => {
  it("passes when every pre-check holds and the simulation passed", () => {
    expect(assessTransferPreflight({ amount: 3n, state: state() })).toBeNull();
  });

  it("passes when the amount equals the balance", () => {
    expect(assessTransferPreflight({ amount: 10n, state: state() })).toBeNull();
  });

  it.each<[string, Partial<TransferChainState>, bigint, TransferPreflightFailure]>([
    ["a paused token", { tokenPaused: true }, 3n, "token_paused"],
    ["an unauthorized recipient", { recipientAuthorized: false }, 3n, "recipient_not_authorized"],
    ["an amount above the balance", { senderBalance: 2n }, 3n, "insufficient_balance"],
  ])("reports %s from the pre-checks alone", (_name, overrides, amount, expected) => {
    expect(assessTransferPreflight({ amount, state: state(overrides) })).toBe(expected);
  });

  it.each<[string | undefined, TransferPreflightFailure]>([
    ["TransferLaneClosed", "transfer_lane_closed"],
    ["TokenIsPaused", "token_paused"],
    ["EnforcedPause", "token_paused"],
    ["HolderNotAuthorized", "recipient_not_authorized"],
    ["ERC1155InsufficientBalance", "insufficient_balance"],
    ["ERC1155InvalidReceiver", "recipient_cannot_receive"],
    ["ERC1155InvalidSender", "transfer_would_revert"],
    ["ERC1155MissingApprovalForAll", "transfer_would_revert"],
    ["Error", "transfer_would_revert"],
    ["Panic", "transfer_would_revert"],
    ["SomethingTheAbiDoesNotKnow", "transfer_would_revert"],
    [undefined, "transfer_would_revert"],
  ])("maps a simulation revert of %s to %s", (errorName, expected) => {
    expect(assessTransferPreflight({ amount: 3n, state: state({ simulation: reverted(errorName) }) })).toBe(
      expected,
    );
  });

  it("does not treat inherited object keys as known revert names", () => {
    for (const errorName of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(
        assessTransferPreflight({ amount: 3n, state: state({ simulation: reverted(errorName) }) }),
      ).toBe("transfer_would_revert");
    }
  });

  it("lets a closed lane beat every request-specific reason", () => {
    const everythingWrong = state({
      tokenPaused: true,
      recipientAuthorized: false,
      senderBalance: 0n,
      simulation: reverted("TransferLaneClosed"),
    });

    expect(assessTransferPreflight({ amount: 3n, state: everythingWrong })).toBe("transfer_lane_closed");
  });

  it("keeps the existing order: paused beats unauthorized beats insufficient balance", () => {
    expect(
      assessTransferPreflight({
        amount: 3n,
        state: state({ tokenPaused: true, recipientAuthorized: false, senderBalance: 0n }),
      }),
    ).toBe("token_paused");
    expect(
      assessTransferPreflight({
        amount: 3n,
        state: state({ recipientAuthorized: false, senderBalance: 0n }),
      }),
    ).toBe("recipient_not_authorized");
    expect(assessTransferPreflight({ amount: 3n, state: state({ senderBalance: 0n }) })).toBe(
      "insufficient_balance",
    );
  });

  it("still reports a pause the simulation found when the pre-check read not-paused", () => {
    expect(
      assessTransferPreflight({
        amount: 3n,
        state: state({ tokenPaused: false, simulation: reverted("TokenIsPaused") }),
      }),
    ).toBe("token_paused");
  });

  it("ranks a request-specific pre-check above a generic revert", () => {
    expect(
      assessTransferPreflight({
        amount: 3n,
        state: state({ recipientAuthorized: false, simulation: reverted() }),
      }),
    ).toBe("recipient_not_authorized");
  });

  it("is deterministic for the same snapshot", () => {
    const snapshot = state({ senderBalance: 1n, simulation: reverted("ERC1155InvalidReceiver") });

    expect(assessTransferPreflight({ amount: 3n, state: snapshot })).toBe(
      assessTransferPreflight({ amount: 3n, state: snapshot }),
    );
  });
});
