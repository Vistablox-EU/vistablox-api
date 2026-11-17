/**
 * Pure rules for the offering's IPO escrow campaign (AD-256) as the
 * reservation gate sees it (#176, AD-286, decided 2026-11-17). The campaign
 * lives on-chain in VistaBloxIpoEscrow; settlement.ipo_escrow_campaigns holds
 * the last observation of it. These rules turn a read of the chain into a
 * state, compare it with what the offering would use, and decide what an
 * operator run does about it. No chain, database or clock access here.
 */

export const IPO_ESCROW_CAMPAIGN_STATES = ["not_opened", "open", "successful", "failed"] as const;
export type IpoEscrowCampaignState = (typeof IPO_ESCROW_CAMPAIGN_STATES)[number];

// VistaBloxIpoEscrow.sol's CampaignState enum, in declaration order.
const CHAIN_STATE_BY_CODE: Record<number, IpoEscrowCampaignState> = {
  0: "not_opened",
  1: "open",
  2: "successful",
  3: "failed",
};

/** Maps the `state` campaignOf returns; an unknown code is a contract this code does not know. */
export function ipoEscrowCampaignStateFromChain(code: number): IpoEscrowCampaignState {
  const state = CHAIN_STATE_BY_CODE[code];
  if (state === undefined) throw new Error(`campaignOf returned an unknown campaign state ${code}`);
  return state;
}

/** The parameters the offering would open its campaign with (what the handoff job also uses). */
export interface ExpectedIpoEscrowCampaign {
  /** The escrow contract this backend is configured to use. */
  escrowContractAddress: string;
  /** EURC base units (6 decimals). */
  targetAmount: bigint;
  /** Unix seconds. */
  deadline: bigint;
  /** PIV_TREASURY_ADDRESS (the single placeholder, C-008 question 3 is open). */
  treasuryAddress: string;
}

/** What campaignOf reports, with the contract it was read from. */
export interface ObservedIpoEscrowCampaign {
  state: IpoEscrowCampaignState;
  escrowContractAddress: string;
  targetAmount: bigint;
  /** Unix seconds. */
  deadline: bigint;
  treasuryAddress: string;
}

export type IpoEscrowCampaignParameter = "target_amount" | "deadline" | "treasury" | "escrow_address";

export interface IpoEscrowCampaignDifference {
  parameter: IpoEscrowCampaignParameter;
  expected: string;
  actual: string;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The parameters in which an existing campaign differs from what the offering
 * would use. Empty means it is the offering's campaign. A campaign with other
 * parameters is never adopted: it would take contributions towards a target,
 * deadline or treasury the offering did not choose.
 */
export function ipoEscrowCampaignDifferences(
  expected: ExpectedIpoEscrowCampaign,
  observed: Pick<ObservedIpoEscrowCampaign, "escrowContractAddress" | "targetAmount" | "deadline" | "treasuryAddress">,
): IpoEscrowCampaignDifference[] {
  const differences: IpoEscrowCampaignDifference[] = [];
  if (observed.targetAmount !== expected.targetAmount) {
    differences.push({
      parameter: "target_amount",
      expected: expected.targetAmount.toString(),
      actual: observed.targetAmount.toString(),
    });
  }
  if (observed.deadline !== expected.deadline) {
    differences.push({
      parameter: "deadline",
      expected: expected.deadline.toString(),
      actual: observed.deadline.toString(),
    });
  }
  if (!sameAddress(observed.treasuryAddress, expected.treasuryAddress)) {
    differences.push({
      parameter: "treasury",
      expected: expected.treasuryAddress,
      actual: observed.treasuryAddress,
    });
  }
  if (!sameAddress(observed.escrowContractAddress, expected.escrowContractAddress)) {
    differences.push({
      parameter: "escrow_address",
      expected: expected.escrowContractAddress,
      actual: observed.escrowContractAddress,
    });
  }
  return differences;
}

/** The last observation stored for the offering's PIV, if there is a row. */
export interface RecordedIpoEscrowCampaign {
  escrowContractAddress: string;
  observedState: IpoEscrowCampaignState;
}

export type IpoEscrowCampaignAction =
  /** The chain shows no campaign: open it (a transaction signed by the operator key). */
  | { kind: "open" }
  /** Open with the offering's own parameters: record the observation (an adoption when nothing was recorded). */
  | { kind: "record_open"; adopted: boolean }
  /** Open, but not with the offering's parameters: refused, nothing is recorded. */
  | { kind: "refuse_mismatch"; differences: IpoEscrowCampaignDifference[] }
  /** Successful or Failed on-chain: it can take no contribution. Recorded as such when a row exists. */
  | { kind: "resolved"; state: "successful" | "failed"; hasRow: boolean };

/**
 * What an operator run does about one offering, from the chain's answer and the
 * stored observation.
 *
 * A row recorded for another escrow contract (the contract was redeployed) is
 * refused whatever the chain says about the configured one: the row would
 * describe a contract this backend no longer uses, and recording over it would
 * hide that. An Open campaign is adopted only when every parameter matches. A
 * campaign the chain no longer shows although a row says it was opened (a
 * reorged open transaction) is opened again.
 */
export function planIpoEscrowCampaignAction(input: {
  expected: ExpectedIpoEscrowCampaign;
  observed: ObservedIpoEscrowCampaign;
  recorded: RecordedIpoEscrowCampaign | null;
}): IpoEscrowCampaignAction {
  const { expected, observed, recorded } = input;
  if (recorded !== null && !sameAddress(recorded.escrowContractAddress, expected.escrowContractAddress)) {
    return {
      kind: "refuse_mismatch",
      differences: [
        {
          parameter: "escrow_address",
          expected: expected.escrowContractAddress,
          actual: recorded.escrowContractAddress,
        },
      ],
    };
  }
  switch (observed.state) {
    case "not_opened":
      return { kind: "open" };
    case "open": {
      const differences = ipoEscrowCampaignDifferences(expected, observed);
      return differences.length > 0
        ? { kind: "refuse_mismatch", differences }
        : { kind: "record_open", adopted: recorded === null };
    }
    case "successful":
    case "failed":
      return { kind: "resolved", state: observed.state, hasRow: recorded !== null };
  }
}

/**
 * AD-234: until the activation gate passes, chain writes of this kind run on
 * Base Sepolia only.
 */
export function isTestnetChainNetwork(network: string | undefined): boolean {
  return network === "base-sepolia";
}

export type IpoEscrowActivationRefusal =
  | { reason: "settlement_bundle_not_configured"; detail: string }
  | { reason: "not_testnet"; detail: string };

/**
 * What the operator command checks before it touches anything: the settlement
 * bundle is configured (without it there is no chain to read) and the
 * configured chain is a testnet (AD-286: the command refuses anywhere else,
 * AD-234 keeps Base Sepolia until the activation gate passes). Null means go on.
 */
export function ipoEscrowActivationRefusal(input: {
  settlementBundleConfigured: boolean;
  chainNetwork: string | undefined;
}): IpoEscrowActivationRefusal | null {
  if (!input.settlementBundleConfigured) {
    return {
      reason: "settlement_bundle_not_configured",
      detail:
        "the settlement bundle (CHAIN_NETWORK, CHAIN_RPC_URL, CHAIN_OPERATOR_PRIVATE_KEY, VISTABLOX_PROPERTY_CONTRACT_ADDRESS, " +
        "VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS, EURC_TOKEN_ADDRESS, PIV_TREASURY_ADDRESS) is not configured here, " +
        "so there is no chain to open a campaign on (AD-234)",
    };
  }
  if (!isTestnetChainNetwork(input.chainNetwork)) {
    return {
      reason: "not_testnet",
      detail:
        `CHAIN_NETWORK is ${input.chainNetwork ?? "unset"}; this command only runs on base-sepolia until the ` +
        "activation gate passes (AD-234)",
    };
  }
  return null;
}
