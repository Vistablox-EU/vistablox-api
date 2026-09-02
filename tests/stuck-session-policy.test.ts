import { describe, expect, it } from "vitest";

import { isSessionStuck } from "../src/modules/identity/domain/stuck-session.policy.js";

describe("isSessionStuck", () => {
  it("is not stuck before the timeout has elapsed", () => {
    expect(
      isSessionStuck({
        updatedAt: new Date("2026-09-02T12:00:00.000Z"),
        now: new Date("2026-09-02T12:14:59.999Z"),
        timeoutMs: 15 * 60 * 1000,
      }),
    ).toBe(false);
  });

  it("is stuck exactly at the timeout", () => {
    expect(
      isSessionStuck({
        updatedAt: new Date("2026-09-02T12:00:00.000Z"),
        now: new Date("2026-09-02T12:15:00.000Z"),
        timeoutMs: 15 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it("stays stuck well past the timeout, not just at the boundary", () => {
    expect(
      isSessionStuck({
        updatedAt: new Date("2026-09-02T12:00:00.000Z"),
        now: new Date("2026-09-03T12:00:00.000Z"),
        timeoutMs: 15 * 60 * 1000,
      }),
    ).toBe(true);
  });
});
