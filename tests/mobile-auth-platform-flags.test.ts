import { describe, expect, it } from "vitest";

import {
  ANDROID_ONLY_MOBILE_PLATFORM_POLICY,
  mobileAuthPlatformFlags,
} from "../src/modules/auth/domain/mobile-platform.policy.js";

describe("mobileAuthPlatformFlags (C1 mobile_auth_platforms)", () => {
  it("advertises exactly what the Android-only policy enforces", () => {
    expect(mobileAuthPlatformFlags(ANDROID_ONLY_MOBILE_PLATFORM_POLICY)).toEqual({ android: true, ios: false });
  });

  it("follows the policy when iOS is added", () => {
    expect(mobileAuthPlatformFlags({ supportedPlatforms: ["android", "ios"] })).toEqual({
      android: true,
      ios: true,
    });
  });

  it("reports every platform off for an empty policy", () => {
    expect(mobileAuthPlatformFlags({ supportedPlatforms: [] })).toEqual({ android: false, ios: false });
  });
});
