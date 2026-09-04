import { describe, expect, it, vi } from "vitest";

import { FinalizeIpoEscrowCampaignsService } from "../src/modules/settlement/application/finalize-ipo-escrow-campaigns.service.js";
import type {
  PivPendingEscrowResolution,
  RecordEscrowMintedPositionInput,
  SettlementRepository,
} from "../src/modules/settlement/repository/settlement.repository.js";

const CAMPAIGN_STATE_OPEN = 1;
const CAMPAIGN_STATE_SUCCESSFUL = 2;
const CAMPAIGN_STATE_FAILED = 3;

interface FakeCampaign {
  targetAmount: bigint;
  totalRaised: bigint;
  deadline: bigint;
  treasury: string;
  state: number;
  swept: boolean;
}

// A small in-memory model of VistaBloxIpoEscrow's own state machine, not
// just a sequence of canned return values -- so the orchestration logic
// under test is genuinely driving state transitions (Open -> Successful/
// Failed -> swept), the same way it would against the real contract.
function makeFakeChain(options: {
  campaigns: Map<string, FakeCampaign>;
  contributions: Map<string, Map<string, bigint>>;
  contributors: Map<string, string[]>;
}) {
  let txCounter = 0;
  const nextHash = () => `0xtx${++txCounter}`;

  return {
    config: { propertyContractAddress: "0xPROPERTY0000000000000000000000000000000" },
    publicClient: {
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" as const })),
    },
    ipoEscrow: {
      read: {
        campaignOf: vi.fn(async ([tokenId]: [bigint]) => {
          const campaign = options.campaigns.get(tokenId.toString())!;
          return [
            campaign.targetAmount,
            campaign.totalRaised,
            campaign.deadline,
            campaign.treasury,
            campaign.state,
            campaign.swept,
          ] as const;
        }),
        contributorsOf: vi.fn(async ([tokenId]: [bigint]) => options.contributors.get(tokenId.toString()) ?? []),
        contributionOf: vi.fn(
          async ([tokenId, address]: [bigint, string]) =>
            options.contributions.get(tokenId.toString())?.get(address) ?? 0n,
        ),
      },
      write: {
        finalize: vi.fn(async ([tokenId]: [bigint]) => {
          const campaign = options.campaigns.get(tokenId.toString())!;
          campaign.state =
            campaign.totalRaised >= campaign.targetAmount ? CAMPAIGN_STATE_SUCCESSFUL : CAMPAIGN_STATE_FAILED;
          return nextHash();
        }),
        withdrawRaised: vi.fn(async ([tokenId]: [bigint]) => {
          options.campaigns.get(tokenId.toString())!.swept = true;
          return nextHash();
        }),
      },
    },
    property: {
      write: {
        authorizeHolder: vi.fn(async () => nextHash()),
        mint: vi.fn(async () => nextHash()),
      },
    },
  };
}

class FakeSettlementRepository implements SettlementRepository {
  public readonly recordedPositions: RecordEscrowMintedPositionInput[] = [];
  private readonly walletToAccount: Map<string, string>;
  private readonly existingPositions: Set<string>;

  public constructor(
    private readonly candidates: PivPendingEscrowResolution[],
    walletToAccount: Record<string, string>,
    existingPositions: Array<{ pivId: string; accountId: string }> = [],
  ) {
    this.walletToAccount = new Map(Object.entries(walletToAccount));
    this.existingPositions = new Set(existingPositions.map((p) => `${p.pivId}:${p.accountId}`));
  }

  public async findPivsWithPassedIpoDeadline(): Promise<PivPendingEscrowResolution[]> {
    return this.candidates;
  }

  public async resolveAccountIdForWallet(walletAddress: string): Promise<string | null> {
    return this.walletToAccount.get(walletAddress) ?? null;
  }

  public async hasPosition(pivId: string, accountId: string): Promise<boolean> {
    return this.existingPositions.has(`${pivId}:${accountId}`);
  }

  public async recordEscrowMintedPosition(
    input: RecordEscrowMintedPositionInput,
  ): Promise<{ positionId: string }> {
    this.recordedPositions.push(input);
    this.existingPositions.add(`${input.pivId}:${input.accountId}`);
    return { positionId: `position_fake_${this.recordedPositions.length}` };
  }
}

describe("FinalizeIpoEscrowCampaignsService", () => {
  it("finalizes a fully-funded campaign as Successful, mints every contributor, and sweeps to treasury", async () => {
    const campaigns = new Map([
      [
        "1",
        {
          targetAmount: 300_000_000_000n,
          totalRaised: 300_000_000_000n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_OPEN,
          swept: false,
        },
      ],
    ]);
    const contributions = new Map([
      ["1", new Map([["0xInvestorA", 200_000_000_000n], ["0xInvestorB", 100_000_000_000n]])],
    ]);
    const contributors = new Map([["1", ["0xInvestorA", "0xInvestorB"]]]);
    const chain = makeFakeChain({ campaigns, contributions, contributors });
    const repository = new FakeSettlementRepository([{ pivId: "piv_1", tokenId: "1" }], {
      "0xInvestorA": "account_a",
      "0xInvestorB": "account_b",
    });

    const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, () => new Date());
    const summary = await service.execute();

    expect(summary).toMatchObject({
      pivsChecked: 1,
      campaignsFinalized: 1,
      campaignsSuccessful: 1,
      campaignsFailed: 0,
      positionsMinted: 2,
      errors: [],
    });
    expect(chain.ipoEscrow.write.finalize).toHaveBeenCalledTimes(1);
    expect(chain.property.write.authorizeHolder).toHaveBeenCalledTimes(2);
    expect(chain.property.write.mint).toHaveBeenCalledTimes(2);
    expect(chain.ipoEscrow.write.withdrawRaised).toHaveBeenCalledTimes(1);
    expect(campaigns.get("1")!.swept).toBe(true);

    expect(repository.recordedPositions).toHaveLength(2);
    const positionA = repository.recordedPositions.find((p) => p.accountId === "account_a")!;
    expect(positionA.unitCount).toBe("200000.000000");
    expect(positionA.costBasisEur).toBe("200000.000000");
  });

  it("finalizes an underfunded campaign as Failed and does not mint or sweep", async () => {
    const campaigns = new Map([
      [
        "2",
        {
          targetAmount: 300_000_000_000n,
          totalRaised: 100_000_000_000n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_OPEN,
          swept: false,
        },
      ],
    ]);
    const chain = makeFakeChain({
      campaigns,
      contributions: new Map(),
      contributors: new Map([["2", ["0xInvestorA"]]]),
    });
    const repository = new FakeSettlementRepository([{ pivId: "piv_2", tokenId: "2" }], {});

    const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, () => new Date());
    const summary = await service.execute();

    expect(summary).toMatchObject({
      campaignsFinalized: 1,
      campaignsSuccessful: 0,
      campaignsFailed: 1,
      positionsMinted: 0,
    });
    expect(chain.property.write.mint).not.toHaveBeenCalled();
    expect(chain.ipoEscrow.write.withdrawRaised).not.toHaveBeenCalled();
  });

  it("skips an already-swept campaign entirely", async () => {
    const campaigns = new Map([
      [
        "3",
        {
          targetAmount: 100n,
          totalRaised: 100n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_SUCCESSFUL,
          swept: true,
        },
      ],
    ]);
    const chain = makeFakeChain({ campaigns, contributions: new Map(), contributors: new Map() });
    const repository = new FakeSettlementRepository([{ pivId: "piv_3", tokenId: "3" }], {});

    const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, () => new Date());
    const summary = await service.execute();

    expect(summary).toMatchObject({ campaignsFinalized: 0, campaignsSuccessful: 0, campaignsFailed: 0 });
    expect(chain.ipoEscrow.write.finalize).not.toHaveBeenCalled();
  });

  it("does not re-call finalize on a campaign that's already Successful but not yet swept (resumed after an interruption)", async () => {
    const campaigns = new Map([
      [
        "4",
        {
          targetAmount: 100n,
          totalRaised: 100n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_SUCCESSFUL,
          swept: false,
        },
      ],
    ]);
    const contributions = new Map([["4", new Map([["0xInvestorA", 100n]])]]);
    const contributors = new Map([["4", ["0xInvestorA"]]]);
    const chain = makeFakeChain({ campaigns, contributions, contributors });
    const repository = new FakeSettlementRepository([{ pivId: "piv_4", tokenId: "4" }], {
      "0xInvestorA": "account_a",
    });

    const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, () => new Date());
    const summary = await service.execute();

    expect(chain.ipoEscrow.write.finalize).not.toHaveBeenCalled();
    expect(summary.campaignsFinalized).toBe(0);
    expect(summary.campaignsSuccessful).toBe(1);
    expect(summary.positionsMinted).toBe(1);
    expect(chain.ipoEscrow.write.withdrawRaised).toHaveBeenCalledTimes(1);
  });

  it("skips a contributor who already has a position, without re-minting, while still minting the rest", async () => {
    const campaigns = new Map([
      [
        "5",
        {
          targetAmount: 200n,
          totalRaised: 200n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_SUCCESSFUL,
          swept: false,
        },
      ],
    ]);
    const contributions = new Map([["5", new Map([["0xInvestorA", 100n], ["0xInvestorB", 100n]])]]);
    const contributors = new Map([["5", ["0xInvestorA", "0xInvestorB"]]]);
    const chain = makeFakeChain({ campaigns, contributions, contributors });
    const repository = new FakeSettlementRepository(
      [{ pivId: "piv_5", tokenId: "5" }],
      { "0xInvestorA": "account_a", "0xInvestorB": "account_b" },
      [{ pivId: "piv_5", accountId: "account_a" }], // already minted on a prior, interrupted run
    );

    const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, () => new Date());
    const summary = await service.execute();

    expect(summary.positionsMinted).toBe(1);
    expect(chain.property.write.mint).toHaveBeenCalledTimes(1);
    expect(repository.recordedPositions).toHaveLength(1);
    expect(repository.recordedPositions[0]?.accountId).toBe("account_b");
  });

  it("records a per-campaign error without aborting other candidates in the same run", async () => {
    const campaigns = new Map([
      [
        "6",
        {
          targetAmount: 100n,
          totalRaised: 100n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_SUCCESSFUL,
          swept: false,
        },
      ],
      [
        "7",
        {
          targetAmount: 100n,
          totalRaised: 100n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_SUCCESSFUL,
          swept: false,
        },
      ],
    ]);
    const contributions = new Map([
      ["6", new Map([["0xUnregistered", 100n]])],
      ["7", new Map([["0xInvestorA", 100n]])],
    ]);
    const contributors = new Map([
      ["6", ["0xUnregistered"]],
      ["7", ["0xInvestorA"]],
    ]);
    const chain = makeFakeChain({ campaigns, contributions, contributors });
    const repository = new FakeSettlementRepository(
      [
        { pivId: "piv_6", tokenId: "6" },
        { pivId: "piv_7", tokenId: "7" },
      ],
      { "0xInvestorA": "account_a" }, // 0xUnregistered deliberately has no account
    );

    const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, () => new Date());
    const summary = await service.execute();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("piv_id=piv_6");
    expect(summary.errors[0]).toContain("0xUnregistered");
    // Campaign 7 (unrelated) still fully processed despite campaign 6's failure.
    expect(summary.positionsMinted).toBe(1);
    expect(campaigns.get("7")!.swept).toBe(true);
    // Campaign 6 never got its treasury sweep -- a real, unresolved
    // contributor is more important than releasing funds on schedule.
    expect(campaigns.get("6")!.swept).toBe(false);
  });
});
