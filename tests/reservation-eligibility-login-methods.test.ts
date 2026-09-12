import { describe, expect, it } from "vitest";

import {
  computeReservationBlockers,
  isLoginMethodsComplete,
} from "../src/modules/offering/domain/reservation-eligibility.policy.js";

type LoginMethod = Parameters<typeof isLoginMethodsComplete>[0][number];

const now = new Date("2026-09-12T12:00:00.000Z");

function blockers(loginMethods: LoginMethod[]) {
  return computeReservationBlockers({
    now,
    fundingRailAvailable: true,
    offeringStatus: "pre_offering",
    finalTermsPublished: false,
    hasDisclosurePack: true,
    remainingCapacityEur: "1000.00",
    accountStatus: "active",
    kycEligibilityState: "eligible",
    kycRenewalDueAt: new Date("2027-01-01T00:00:00.000Z"),
    loginMethods,
    walletProvisioned: true,
    recoveryCooldownEndsAt: null,
  });
}

// Investing needs an enrolled device (device_key) plus Google or Apple.
// Customer passkeys are gone, so a passkey row no longer counts.
describe("reservation eligibility: login methods", () => {
  it("is complete with an enrolled device and Google", () => {
    expect(isLoginMethodsComplete(["google", "device_key"])).toBe(true);
    expect(blockers(["google", "device_key"])).toEqual([]);
  });

  it("is complete with an enrolled device and Apple", () => {
    expect(isLoginMethodsComplete(["apple", "device_key"])).toBe(true);
    expect(blockers(["apple", "device_key"])).toEqual([]);
  });

  it("is incomplete without an enrolled device", () => {
    expect(isLoginMethodsComplete(["google", "apple"])).toBe(false);
    expect(blockers(["google", "apple"])).toEqual(["login_methods_incomplete"]);
  });

  it("is incomplete with only an enrolled device", () => {
    expect(isLoginMethodsComplete(["device_key"])).toBe(false);
    expect(blockers(["device_key"])).toEqual(["login_methods_incomplete"]);
  });

  it("no longer counts a legacy passkey in place of the device", () => {
    expect(isLoginMethodsComplete(["google", "passkey"])).toBe(false);
    expect(blockers(["google", "passkey"])).toEqual(["login_methods_incomplete"]);
  });

  it("is incomplete with no login methods", () => {
    expect(blockers([])).toEqual(["login_methods_incomplete"]);
  });
});
