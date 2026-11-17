import { describe, expect, it } from "vitest";

import {
  ipoEscrowActivationRefusal,
  ipoEscrowCampaignDifferences,
  ipoEscrowCampaignStateFromChain,
  isTestnetChainNetwork,
  planIpoEscrowCampaignAction,
  type ExpectedIpoEscrowCampaign,
  type ObservedIpoEscrowCampaign,
} from "../src/modules/settlement/domain/ipo-escrow-campaign.policy.js";

const ESCROW = "0x00000000000000000000000000000000000E5c20";
const TREASURY = "0x000000000000000000000000000000000000Ba5e";

const expected: ExpectedIpoEscrowCampaign = {
  escrowContractAddress: ESCROW,
  targetAmount: 500_000_000_000n,
  deadline: 1_790_000_000n,
  treasuryAddress: TREASURY,
};

function observed(overrides: Partial<ObservedIpoEscrowCampaign> = {}): ObservedIpoEscrowCampaign {
  return {
    state: "open",
    escrowContractAddress: ESCROW,
    targetAmount: expected.targetAmount,
    deadline: expected.deadline,
    treasuryAddress: TREASURY,
    ...overrides,
  };
}

describe("ipoEscrowCampaignStateFromChain", () => {
  it.each([
    [0, "not_opened"],
    [1, "open"],
    [2, "successful"],
    [3, "failed"],
  ] as const)("maps VistaBloxIpoEscrow's CampaignState %i to %s", (code, state) => {
    expect(ipoEscrowCampaignStateFromChain(code)).toBe(state);
  });

  it.each([4, -1, 255])("throws for the unknown code %i", (code) => {
    expect(() => ipoEscrowCampaignStateFromChain(code)).toThrow(/unknown campaign state/);
  });
});

describe("ipoEscrowCampaignDifferences", () => {
  it("is empty for the offering's own campaign, comparing addresses without regard to case", () => {
    expect(
      ipoEscrowCampaignDifferences(
        expected,
        observed({ escrowContractAddress: ESCROW.toLowerCase(), treasuryAddress: TREASURY.toUpperCase().replace("0X", "0x") }),
      ),
    ).toEqual([]);
  });

  it.each([
    ["target", { targetAmount: 1n }, "target_amount", "500000000000", "1"],
    ["deadline", { deadline: 5n }, "deadline", "1790000000", "5"],
    ["treasury", { treasuryAddress: "0x0000000000000000000000000000000000000001" }, "treasury", TREASURY, "0x0000000000000000000000000000000000000001"],
    [
      "escrow address",
      { escrowContractAddress: "0x0000000000000000000000000000000000000002" },
      "escrow_address",
      ESCROW,
      "0x0000000000000000000000000000000000000002",
    ],
  ] as const)("names the %s when only it differs", (_name, change, parameter, expectedValue, actual) => {
    expect(ipoEscrowCampaignDifferences(expected, observed(change))).toEqual([
      { parameter, expected: expectedValue, actual },
    ]);
  });
});

describe("planIpoEscrowCampaignAction", () => {
  it("opens a campaign the chain does not show", () => {
    expect(planIpoEscrowCampaignAction({ expected, observed: observed({ state: "not_opened" }), recorded: null })).toEqual({
      kind: "open",
    });
  });

  it("adopts an Open campaign with exactly the offering's parameters when nothing is recorded", () => {
    expect(planIpoEscrowCampaignAction({ expected, observed: observed(), recorded: null })).toEqual({
      kind: "record_open",
      adopted: true,
    });
  });

  it("refreshes, rather than adopts, an Open campaign that is already recorded", () => {
    expect(
      planIpoEscrowCampaignAction({
        expected,
        observed: observed(),
        recorded: { escrowContractAddress: ESCROW.toLowerCase(), observedState: "open" },
      }),
    ).toEqual({ kind: "record_open", adopted: false });
  });

  it("refuses an Open campaign whose parameters differ, naming each", () => {
    expect(
      planIpoEscrowCampaignAction({
        expected,
        observed: observed({ targetAmount: 1n, deadline: 2n }),
        recorded: null,
      }),
    ).toEqual({
      kind: "refuse_mismatch",
      differences: [
        { parameter: "target_amount", expected: "500000000000", actual: "1" },
        { parameter: "deadline", expected: "1790000000", actual: "2" },
      ],
    });
  });

  it.each(["successful", "failed"] as const)("reports a %s campaign as resolved, and whether a row exists to move", (state) => {
    expect(planIpoEscrowCampaignAction({ expected, observed: observed({ state }), recorded: null })).toEqual({
      kind: "resolved",
      state,
      hasRow: false,
    });
    expect(
      planIpoEscrowCampaignAction({
        expected,
        observed: observed({ state }),
        recorded: { escrowContractAddress: ESCROW, observedState: "open" },
      }),
    ).toEqual({ kind: "resolved", state, hasRow: true });
  });

  it("opens again when a row says it was opened but the chain no longer shows it (a dropped open transaction)", () => {
    expect(
      planIpoEscrowCampaignAction({
        expected,
        observed: observed({ state: "not_opened" }),
        recorded: { escrowContractAddress: ESCROW, observedState: "open" },
      }),
    ).toEqual({ kind: "open" });
  });

  it.each(["not_opened", "open", "successful", "failed"] as const)(
    "refuses a row recorded for another escrow contract whatever the configured contract shows (%s)",
    (state) => {
      expect(
        planIpoEscrowCampaignAction({
          expected,
          observed: observed({ state }),
          recorded: { escrowContractAddress: "0x0000000000000000000000000000000000000009", observedState: "open" },
        }),
      ).toEqual({
        kind: "refuse_mismatch",
        differences: [
          { parameter: "escrow_address", expected: ESCROW, actual: "0x0000000000000000000000000000000000000009" },
        ],
      });
    },
  );
});

describe("isTestnetChainNetwork and ipoEscrowActivationRefusal (AD-234)", () => {
  it("accepts base-sepolia only", () => {
    expect(isTestnetChainNetwork("base-sepolia")).toBe(true);
    expect(isTestnetChainNetwork("base")).toBe(false);
    expect(isTestnetChainNetwork(undefined)).toBe(false);
    expect(isTestnetChainNetwork("")).toBe(false);
  });

  it("lets a configured bundle on base-sepolia go on", () => {
    expect(ipoEscrowActivationRefusal({ settlementBundleConfigured: true, chainNetwork: "base-sepolia" })).toBeNull();
  });

  it("refuses the base mainnet", () => {
    expect(ipoEscrowActivationRefusal({ settlementBundleConfigured: true, chainNetwork: "base" })).toMatchObject({
      reason: "not_testnet",
    });
  });

  it("refuses where the settlement bundle is dormant, before it looks at the network", () => {
    expect(ipoEscrowActivationRefusal({ settlementBundleConfigured: false, chainNetwork: "base-sepolia" })).toMatchObject({
      reason: "settlement_bundle_not_configured",
    });
    expect(ipoEscrowActivationRefusal({ settlementBundleConfigured: false, chainNetwork: undefined })).toMatchObject({
      reason: "settlement_bundle_not_configured",
    });
  });
});
