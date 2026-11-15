import { describe, expect, it } from "vitest";

import {
  WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH,
  decideRegisteredRowEvent,
  finalCursor,
  rewindTargetFor,
  type RegisteredRowView,
} from "../src/modules/settlement/domain/wallet-registration-event.policy.js";
import type { WalletRegistrationEvidence } from "../src/shared/domain/wallet-registration-evidence.js";

const WALLET = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const TX = `0x${"11".repeat(32)}`;
const OTHER_TX = `0x${"12".repeat(32)}`;
const BLOCK = `0x${"22".repeat(32)}`;
const OTHER_BLOCK = `0x${"23".repeat(32)}`;

const event: WalletRegistrationEvidence = { transactionHash: TX, blockHash: BLOCK, blockNumber: 100n, logIndex: 3 };
const recorded: RegisteredRowView = { walletAddress: WALLET, transactionHash: TX, blockHash: BLOCK, logIndex: 3, evidenceFlag: null };

describe("decideRegisteredRowEvent", () => {
  it("treats the identical event as a replay", () => {
    expect(decideRegisteredRowEvent(recorded, WALLET, event)).toBe("replay");
  });

  it("compares hashes and wallets without regard to case", () => {
    const row: RegisteredRowView = { ...recorded, walletAddress: WALLET.toUpperCase().replace("0X", "0x"), transactionHash: TX.toUpperCase().replace("0X", "0x") };
    expect(decideRegisteredRowEvent(row, WALLET, event)).toBe("replay");
  });

  it("refreshes a flagged row whose recorded event is on the chain again", () => {
    expect(decideRegisteredRowEvent({ ...recorded, evidenceFlag: "transaction_missing" }, WALLET, event)).toBe("refresh");
  });

  it("refreshes when the same transaction was mined in another block", () => {
    expect(decideRegisteredRowEvent(recorded, WALLET, { ...event, blockHash: OTHER_BLOCK, blockNumber: 101n })).toBe("refresh");
    expect(decideRegisteredRowEvent(recorded, WALLET, { ...event, blockHash: OTHER_BLOCK, logIndex: 7 })).toBe("refresh");
  });

  it("refreshes a flagged row when its transaction was mined again", () => {
    expect(
      decideRegisteredRowEvent({ ...recorded, evidenceFlag: "event_missing" }, WALLET, { ...event, blockHash: OTHER_BLOCK }),
    ).toBe("refresh");
  });

  it("treats a second matching log in the same transaction and block as a conflict", () => {
    expect(decideRegisteredRowEvent(recorded, WALLET, { ...event, logIndex: 5 })).toBe("conflict");
  });

  it("treats an event from another transaction as a conflict, flagged or not", () => {
    expect(decideRegisteredRowEvent(recorded, WALLET, { ...event, transactionHash: OTHER_TX })).toBe("conflict");
    expect(
      decideRegisteredRowEvent({ ...recorded, evidenceFlag: "transaction_missing" }, WALLET, { ...event, transactionHash: OTHER_TX }),
    ).toBe("conflict");
  });

  it("treats an event emitted for a different wallet as a conflict", () => {
    expect(decideRegisteredRowEvent(recorded, "0x00000000000000000000000000000000000000aa", event)).toBe("conflict");
  });

  it("records evidence on a row that was confirmed without any", () => {
    const none: RegisteredRowView = { ...recorded, transactionHash: null, blockHash: null, logIndex: null };
    expect(decideRegisteredRowEvent(none, WALLET, event)).toBe("record_evidence");
  });

  it("completes a legacy row (transaction hash and block number only) when the transaction is the same", () => {
    const partial: RegisteredRowView = { ...recorded, blockHash: null, logIndex: null };
    expect(decideRegisteredRowEvent(partial, WALLET, event)).toBe("record_evidence");
  });

  it("does not complete a legacy row from a different transaction", () => {
    const partial: RegisteredRowView = { ...recorded, blockHash: null, logIndex: null };
    expect(decideRegisteredRowEvent(partial, WALLET, { ...event, transactionHash: OTHER_TX })).toBe("conflict");
  });
});

describe("finalCursor", () => {
  it("is the end of the scanned range when nothing was rewound", () => {
    expect(finalCursor(500n, [])).toBe(500n);
  });

  it("is the lowest rewind below the scanned range", () => {
    expect(finalCursor(500n, [480n, 470n, 490n])).toBe(470n);
  });

  it("ignores a rewind above the scanned range", () => {
    expect(finalCursor(500n, [600n])).toBe(500n);
  });

  it("never goes below zero", () => {
    expect(finalCursor(500n, [-3n])).toBe(0n);
  });
});

describe("rewindTargetFor", () => {
  it("points just before a confirmation block that is not final yet", () => {
    expect(rewindTargetFor(1_000n, 1_000n + WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH - 1n)).toBe(999n);
  });

  it("does not rewind for a block at or beyond the final depth", () => {
    expect(rewindTargetFor(1_000n, 1_000n + WALLET_REGISTRY_EVIDENCE_FINAL_DEPTH)).toBeNull();
    expect(rewindTargetFor(1_000n, 50_000n)).toBeNull();
  });

  it("clamps at zero", () => {
    expect(rewindTargetFor(0n, 10n)).toBe(0n);
  });
});
