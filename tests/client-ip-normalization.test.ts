import { describe, expect, it } from "vitest";

import { normalizeClientIp } from "../src/shared/http/rate-limit.js";

// RATE_LIMITING.md keys unauthenticated traffic on "a normalized client IP".
describe("normalizeClientIp", () => {
  it("leaves an IPv4 address as it is", () => {
    expect(normalizeClientIp("203.0.113.7")).toBe("203.0.113.7");
  });

  it.each([
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["::FFFF:CB00:7107", "203.0.113.7"],
    ["0:0:0:0:0:ffff:203.0.113.7", "203.0.113.7"],
  ])("unwraps the IPv4-mapped address %s so one client has one bucket", (raw, expected) => {
    expect(normalizeClientIp(raw)).toBe(expected);
  });

  it("keys an IPv6 address on its /64, however it is spelled", () => {
    const expected = "2001:db8:abcd:12::/64";
    for (const raw of [
      "2001:db8:abcd:12::1",
      "2001:db8:abcd:12:ffff:ffff:ffff:ffff",
      "2001:DB8:ABCD:12::2",
      "2001:0db8:abcd:0012:0000:0000:0000:0001",
    ]) {
      expect(normalizeClientIp(raw)).toBe(expected);
    }
    expect(normalizeClientIp("2001:db8:abcd:13::1")).not.toBe(expected);
  });

  it("handles the loopback and unspecified IPv6 addresses", () => {
    expect(normalizeClientIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizeClientIp("::")).toBe("0:0:0:0::/64");
  });

  it("drops a zone id", () => {
    expect(normalizeClientIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it.each([undefined, "", "unknown", "attacker-chosen-bucket", "1.2.3", "203.0.113.7, 198.51.100.1", "2001:db8::zz"])(
    "returns undefined for %j, which is not an IP address",
    (raw) => {
      expect(normalizeClientIp(raw)).toBeUndefined();
    },
  );
});
