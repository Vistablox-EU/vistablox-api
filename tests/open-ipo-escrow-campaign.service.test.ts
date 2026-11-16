import { describe, expect, it, vi } from "vitest";

import { OpenIpoEscrowCampaignService } from "../src/modules/settlement/application/open-ipo-escrow-campaign.service.js";
import { OpenPendingIpoEscrowCampaignsService } from "../src/modules/settlement/application/open-pending-ipo-escrow-campaigns.service.js";
import type { RecordIpoEscrowCampaignOpenedInput } from "../src/modules/settlement/repository/settlement.repository.js";
import { makeCapturingLogger } from "./support/escrow-mint-fakes.js";

const ESCROW = "0x00000000000000000000000000000000000E5c20";
const TREASURY = "0x000000000000000000000000000000000000Ba5e";
const TX_HASH = `0x${"ab".repeat(32)}`;
const DEADLINE_UNIX = 1_790_000_000;

type CampaignOf = readonly [bigint, bigint, bigint, string, number, boolean];

// campaignOf reads in order: the pre-check, then (after a send) the re-read.
function chain(options: { reads: CampaignOf[]; receiptStatus?: "success" | "reverted" }) {
  const reads = [...options.reads];
  const openCampaign = vi.fn().mockResolvedValue(TX_HASH);
  const clients = {
    config: { ipoEscrowContractAddress: ESCROW, pivTreasuryAddress: TREASURY },
    ipoEscrow: {
      read: {
        campaignOf: vi.fn(async () => {
          const next = reads.shift();
          if (next === undefined) throw new Error("unexpected campaignOf read");
          return next;
        }),
      },
      write: { openCampaign },
    },
    publicClient: {
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: options.receiptStatus ?? "success" }),
    },
  };
  return { clients, openCampaign };
}

function repository() {
  const recorded: RecordIpoEscrowCampaignOpenedInput[] = [];
  return {
    recorded,
    recordIpoEscrowCampaignOpened: vi.fn(async (input: RecordIpoEscrowCampaignOpenedInput) => {
      recorded.push(input);
    }),
  };
}

const notOpened: CampaignOf = [0n, 0n, 0n, "0x0000000000000000000000000000000000000000", 0, false];
const open: CampaignOf = [500_000_000_000n, 0n, BigInt(DEADLINE_UNIX), TREASURY, 1, false];

const payload = {
  piv_id: "piv_1",
  token_id: "7",
  target_amount_eurc: "500000000000",
  deadline_unix: DEADLINE_UNIX,
  trace_id: "req_test",
};

describe("OpenIpoEscrowCampaignService readiness record", () => {
  it("opens a new campaign and records it ready from the chain's own values, with the open tx hash", async () => {
    const { clients, openCampaign } = chain({ reads: [notOpened, open] });
    const repo = repository();

    const result = await new OpenIpoEscrowCampaignService(clients as never, repo).execute(payload);

    expect(openCampaign).toHaveBeenCalledWith([7n, 500_000_000_000n, BigInt(DEADLINE_UNIX), TREASURY]);
    expect(result).toEqual({ pivId: "piv_1", tokenId: "7", transactionHash: TX_HASH, ready: true });
    expect(repo.recorded).toEqual([
      {
        pivId: "piv_1",
        tokenId: "7",
        escrowContractAddress: ESCROW,
        targetAmount: 500_000_000_000n,
        deadlineAt: new Date(DEADLINE_UNIX * 1000),
        treasuryAddress: TREASURY,
        openTxHash: TX_HASH,
      },
    ]);
  });

  it("records an already-open campaign on replay without sending a transaction", async () => {
    const { clients, openCampaign } = chain({ reads: [open] });
    const repo = repository();

    const result = await new OpenIpoEscrowCampaignService(clients as never, repo).execute(payload);

    expect(openCampaign).not.toHaveBeenCalled();
    expect(result.ready).toBe(true);
    expect(repo.recorded).toHaveLength(1);
    expect(repo.recorded[0]?.openTxHash).toBeNull();
  });

  it.each([
    ["Successful", 2],
    ["Failed", 3],
  ])("does not record a campaign already resolved as %s, since it can take no contributions", async (_name, state) => {
    const { clients, openCampaign } = chain({ reads: [[1n, 1n, 1n, TREASURY, state, false]] });
    const repo = repository();

    const result = await new OpenIpoEscrowCampaignService(clients as never, repo).execute(payload);

    expect(openCampaign).not.toHaveBeenCalled();
    expect(result.ready).toBe(false);
    expect(repo.recordIpoEscrowCampaignOpened).not.toHaveBeenCalled();
  });

  it("records nothing when the open transaction reverts", async () => {
    const { clients } = chain({ reads: [notOpened], receiptStatus: "reverted" });
    const repo = repository();

    await expect(new OpenIpoEscrowCampaignService(clients as never, repo).execute(payload)).rejects.toThrow(
      /reverted/,
    );
    expect(repo.recordIpoEscrowCampaignOpened).not.toHaveBeenCalled();
  });

  it("fails rather than record readiness when the chain does not show the campaign open after the send", async () => {
    const { clients } = chain({ reads: [notOpened, notOpened] });
    const repo = repository();

    await expect(new OpenIpoEscrowCampaignService(clients as never, repo).execute(payload)).rejects.toThrow(
      /does not show the campaign open/,
    );
    expect(repo.recordIpoEscrowCampaignOpened).not.toHaveBeenCalled();
  });
});

describe("OpenPendingIpoEscrowCampaignsService", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");

  it("opens each awaiting offering with its target raise in EURC base units and its IPO deadline", async () => {
    const ipoEndAt = new Date("2026-11-01T12:00:30.500Z");
    const find = vi.fn().mockResolvedValue([
      { pivId: "piv_1", tokenId: "7", targetRaiseEur: "500000.25", ipoEndAt },
    ]);
    const execute = vi.fn().mockResolvedValue({ ready: true });
    const { logger } = makeCapturingLogger();

    const summary = await new OpenPendingIpoEscrowCampaignsService(
      { findOfferingsAwaitingIpoEscrowCampaign: find },
      { execute },
      logger,
      () => now,
    ).execute("req_sweep");

    expect(find).toHaveBeenCalledWith(now);
    expect(execute).toHaveBeenCalledWith({
      piv_id: "piv_1",
      token_id: "7",
      target_amount_eurc: "500000250000",
      deadline_unix: Math.floor(ipoEndAt.getTime() / 1000),
      trace_id: "req_sweep",
    });
    expect(summary).toEqual({ offeringsChecked: 1, campaignsReady: 1, campaignsNotReady: 0, errors: [] });
  });

  it("keeps going past a failing campaign and counts resolved ones as not ready", async () => {
    const ipoEndAt = new Date("2026-11-01T12:00:00.000Z");
    const find = vi.fn().mockResolvedValue([
      { pivId: "piv_1", tokenId: "1", targetRaiseEur: "100.00", ipoEndAt },
      { pivId: "piv_2", tokenId: "2", targetRaiseEur: "100.00", ipoEndAt },
      { pivId: "piv_3", tokenId: "3", targetRaiseEur: "100.00", ipoEndAt },
    ]);
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValueOnce({ ready: false })
      .mockResolvedValueOnce({ ready: true });
    const { logger, entries } = makeCapturingLogger();

    const summary = await new OpenPendingIpoEscrowCampaignsService(
      { findOfferingsAwaitingIpoEscrowCampaign: find },
      { execute },
      logger,
      () => now,
    ).execute("req_sweep");

    expect(execute).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      offeringsChecked: 3,
      campaignsReady: 1,
      campaignsNotReady: 1,
      errors: ["piv_id=piv_1: rpc down"],
    });
    expect(entries.filter((entry) => entry.level === "error")).toHaveLength(1);
  });
});
