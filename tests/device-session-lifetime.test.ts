import { describe, expect, it } from "vitest";

import {
  DEVICE_SESSION_ABSOLUTE_LIFETIME_MS,
  DEVICE_SESSION_IDLE_TIMEOUT_MS,
  deviceSessionAbsoluteExpiresAt,
  evaluateDeviceSessionLifetime,
} from "../src/modules/auth/domain/device-session-lifetime.js";

const CREATED_AT = new Date("2026-09-11T12:00:00.000Z");
const MINUTE = 60_000;

function at(offsetMs: number): Date {
  return new Date(CREATED_AT.getTime() + offsetMs);
}

describe("device session lifetime (contract 3.6/3.7)", () => {
  it("uses idle 5 min and absolute 30 min", () => {
    expect(DEVICE_SESSION_IDLE_TIMEOUT_MS).toBe(5 * MINUTE);
    expect(DEVICE_SESSION_ABSOLUTE_LIFETIME_MS).toBe(30 * MINUTE);
    expect(deviceSessionAbsoluteExpiresAt(CREATED_AT)).toEqual(at(30 * MINUTE));
  });

  it("is active 1 ms before the idle limit and expired exactly at it", () => {
    expect(
      evaluateDeviceSessionLifetime({ createdAt: CREATED_AT, lastActivityAt: CREATED_AT, now: at(5 * MINUTE - 1) }),
    ).toEqual({ status: "active", idleExpiresAt: at(5 * MINUTE), absoluteExpiresAt: at(30 * MINUTE) });
    expect(
      evaluateDeviceSessionLifetime({ createdAt: CREATED_AT, lastActivityAt: CREATED_AT, now: at(5 * MINUTE) }),
    ).toEqual({ status: "expired", reason: "idle_timeout" });
  });

  it("measures idle from the last activity, not from creation", () => {
    const lastActivityAt = at(12 * MINUTE);
    expect(
      evaluateDeviceSessionLifetime({ createdAt: CREATED_AT, lastActivityAt, now: at(17 * MINUTE - 1) }),
    ).toMatchObject({ status: "active", idleExpiresAt: at(17 * MINUTE) });
    expect(
      evaluateDeviceSessionLifetime({ createdAt: CREATED_AT, lastActivityAt, now: at(17 * MINUTE) }),
    ).toEqual({ status: "expired", reason: "idle_timeout" });
  });

  it("is active 1 ms before the absolute limit and expired exactly at it, however recent the activity", () => {
    expect(
      evaluateDeviceSessionLifetime({
        createdAt: CREATED_AT,
        lastActivityAt: at(30 * MINUTE - 2),
        now: at(30 * MINUTE - 1),
      }),
    ).toMatchObject({ status: "active" });
    expect(
      evaluateDeviceSessionLifetime({
        createdAt: CREATED_AT,
        lastActivityAt: at(30 * MINUTE - 1),
        now: at(30 * MINUTE),
      }),
    ).toEqual({ status: "expired", reason: "absolute_lifetime" });
  });

  it("never moves the absolute limit: activity just before it still leaves the session expiring at creation + 30 min", () => {
    const verdict = evaluateDeviceSessionLifetime({
      createdAt: CREATED_AT,
      lastActivityAt: at(28 * MINUTE),
      now: at(28 * MINUTE),
    });
    expect(verdict).toEqual({
      status: "active",
      // Idle would be 33 min; clamped to the absolute limit.
      idleExpiresAt: at(30 * MINUTE),
      absoluteExpiresAt: at(30 * MINUTE),
    });
  });

  it("reports absolute_lifetime when both limits have passed", () => {
    expect(
      evaluateDeviceSessionLifetime({ createdAt: CREATED_AT, lastActivityAt: CREATED_AT, now: at(45 * MINUTE) }),
    ).toEqual({ status: "expired", reason: "absolute_lifetime" });
  });

  it("treats activity recorded before creation as activity at creation", () => {
    expect(
      evaluateDeviceSessionLifetime({
        createdAt: CREATED_AT,
        lastActivityAt: at(-10 * MINUTE),
        now: at(4 * MINUTE),
      }),
    ).toMatchObject({ status: "active", idleExpiresAt: at(5 * MINUTE) });
  });
});
