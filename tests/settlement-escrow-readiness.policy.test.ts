import { describe, expect, it } from "vitest";

import {
  computeReservationBlockers,
  isSettlementEscrowReady,
  type SettlementEscrowGate,
} from "../src/modules/offering/domain/reservation-eligibility.policy.js";
import { CONFIGURED_ESCROW_CONTRACT, REDEPLOYED_ESCROW_CONTRACT } from "./support/settlement-escrow-contracts.js";

// #176, AD-286: where the settlement bundle is configured, an offering is ready for
// reservations only while its campaign was last observed Open, on the configured
// escrow contract, with its deadline still ahead.
const now = new Date("2026-10-01T12:00:00.000Z");
const ahead = new Date(now.getTime() + 60_000);

function gated(
  campaign: { state?: string; deadlineAt?: Date; escrowContractAddress?: string } | null,
  configured = CONFIGURED_ESCROW_CONTRACT,
): SettlementEscrowGate {
  return {
    gated: true,
    escrowContractAddress: configured,
    campaign:
      campaign === null
        ? null
        : {
            state: campaign.state ?? "open",
            deadlineAt: campaign.deadlineAt ?? ahead,
            escrowContractAddress: campaign.escrowContractAddress ?? CONFIGURED_ESCROW_CONTRACT,
          },
  };
}

describe("isSettlementEscrowReady", () => {
  it.each<[string, SettlementEscrowGate, boolean]>([
    ["no gate (the bundle is dormant)", { gated: false }, true],
    ["gated, nothing recorded", gated(null), false],
    ["Open, deadline ahead, the configured contract", gated({}), true],
    ["Open, deadline one millisecond ahead", gated({ deadlineAt: new Date(now.getTime() + 1) }), true],
    ["Open, deadline exactly now", gated({ deadlineAt: now }), false],
    ["Open, deadline passed", gated({ deadlineAt: new Date(now.getTime() - 1) }), false],
    ["not_opened", gated({ state: "not_opened" }), false],
    ["successful", gated({ state: "successful" }), false],
    ["failed", gated({ state: "failed" }), false],
    ["a state this code does not know", gated({ state: "paused" }), false],
    ["Open, deadline ahead, ANOTHER escrow contract (a redeploy)", gated({ escrowContractAddress: REDEPLOYED_ESCROW_CONTRACT }), false],
    [
      "Open, deadline ahead, an address one digit apart",
      gated({ escrowContractAddress: `${CONFIGURED_ESCROW_CONTRACT.slice(0, -1)}1` }),
      false,
    ],
    [
      "the configured contract, stored in lower case",
      gated({ escrowContractAddress: CONFIGURED_ESCROW_CONTRACT.toLowerCase() }),
      true,
    ],
    [
      "the configured contract, stored in upper case",
      gated({ escrowContractAddress: `0x${CONFIGURED_ESCROW_CONTRACT.slice(2).toUpperCase()}` }),
      true,
    ],
    [
      "the configured contract written in lower case, stored checksummed",
      gated({}, CONFIGURED_ESCROW_CONTRACT.toLowerCase()),
      true,
    ],
    [
      "Open and in time, but on the contract before the redeploy that the configuration now replaces",
      gated({ escrowContractAddress: CONFIGURED_ESCROW_CONTRACT }, REDEPLOYED_ESCROW_CONTRACT),
      false,
    ],
  ])("%s", (_name, gate, expected) => {
    expect(isSettlementEscrowReady(gate, now)).toBe(expected);
  });
});

describe("computeReservationBlockers: settlement_escrow_not_ready", () => {
  function blockers(settlementEscrow: SettlementEscrowGate) {
    return computeReservationBlockers({
      now,
      fundingRailAvailable: true,
      settlementEscrow,
      offeringStatus: "pre_offering",
      finalTermsPublished: false,
      ipoEndAt: new Date(now.getTime() + 86_400_000),
      hasDisclosurePack: true,
      remainingCapacityEur: "1000.00",
      accountStatus: "active",
      kycEligibilityState: "eligible",
      kycRenewalDueAt: new Date("2027-01-01T00:00:00.000Z"),
      loginMethods: ["google", "device_key"],
      walletProvisioned: true,
      recoveryCooldownEndsAt: null,
    });
  }

  it("is raised alone for a campaign recorded for another escrow contract", () => {
    expect(blockers(gated({ escrowContractAddress: REDEPLOYED_ESCROW_CONTRACT }))).toEqual([
      "settlement_escrow_not_ready",
    ]);
  });

  it("is not raised for the configured contract's open campaign, or where there is no gate", () => {
    expect(blockers(gated({}))).toEqual([]);
    expect(blockers({ gated: false })).toEqual([]);
  });
});
