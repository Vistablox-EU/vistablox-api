import { describe, expect, it } from "vitest";

import {
  computeReservationBlockers,
  isWithinIpoPeriod,
} from "../src/modules/offering/domain/reservation-eligibility.policy.js";

const ipoEndAt = new Date("2026-10-01T12:00:00.000Z");

function blockers(input: { now: Date; ipoEndAt: Date | null; finalTermsPublished?: boolean }) {
  return computeReservationBlockers({
    now: input.now,
    fundingRailAvailable: true,
    offeringStatus: "pre_offering",
    finalTermsPublished: input.finalTermsPublished ?? false,
    ipoEndAt: input.ipoEndAt,
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

describe("reservation eligibility: IPO period (ipo_end_at)", () => {
  it("allows a reservation before ipo_end_at", () => {
    const now = new Date(ipoEndAt.getTime() - 1);
    expect(isWithinIpoPeriod({ ipoEndAt, now })).toBe(true);
    expect(blockers({ now, ipoEndAt })).toEqual([]);
  });

  it("closes reservations at exactly ipo_end_at", () => {
    expect(isWithinIpoPeriod({ ipoEndAt, now: ipoEndAt })).toBe(false);
    expect(blockers({ now: ipoEndAt, ipoEndAt })).toEqual(["offering_not_open"]);
  });

  it("closes reservations after ipo_end_at", () => {
    const now = new Date(ipoEndAt.getTime() + 60_000);
    expect(blockers({ now, ipoEndAt })).toEqual(["offering_not_open"]);
  });

  it("fails closed when the case has no ipo_end_at", () => {
    const now = new Date("2026-09-12T12:00:00.000Z");
    expect(isWithinIpoPeriod({ ipoEndAt: null, now })).toBe(false);
    expect(blockers({ now, ipoEndAt: null })).toEqual(["offering_not_open"]);
  });

  it("reports offering_not_open once when the deadline and final terms both close it", () => {
    expect(blockers({ now: ipoEndAt, ipoEndAt, finalTermsPublished: true })).toEqual(["offering_not_open"]);
  });

  it("reopens when ipo_end_at is extended in place", () => {
    const now = new Date(ipoEndAt.getTime() + 60_000);
    const extended = new Date(ipoEndAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(blockers({ now, ipoEndAt: extended })).toEqual([]);
  });
});
