import { describe, expect, it } from "vitest";

import { deriveDeviceLabel } from "../src/modules/auth/domain/device-label.js";

describe("deriveDeviceLabel", () => {
  it("combines browser and OS when both are recognized", () => {
    expect(
      deriveDeviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
  });

  it("recognizes mobile operating systems", () => {
    expect(deriveDeviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)")).toBe("iOS");
    expect(deriveDeviceLabel("Mozilla/5.0 (Linux; Android 14)")).toBe("Android");
  });

  it("returns null for an empty or unrecognized user agent", () => {
    expect(deriveDeviceLabel(null)).toBeNull();
    expect(deriveDeviceLabel("")).toBeNull();
    expect(deriveDeviceLabel("SomeUnknownBot/1.0")).toBeNull();
  });
});
