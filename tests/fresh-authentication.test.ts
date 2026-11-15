import { describe, expect, it } from "vitest";

import { FRESH_AUTH_WINDOW_MS, isFreshDeviceSession } from "../src/modules/auth/domain/fresh-authentication.js";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("isFreshDeviceSession", () => {
  const deviceSession = { population: "customer", authenticationLevel: "device_biometric" };

  it("is fresh for exactly the window after the session was created, and not a millisecond longer", () => {
    expect(isFreshDeviceSession({ ...deviceSession, sessionCreatedAt: ago(0) }, NOW)).toBe(true);
    expect(isFreshDeviceSession({ ...deviceSession, sessionCreatedAt: ago(FRESH_AUTH_WINDOW_MS) }, NOW)).toBe(true);
    expect(isFreshDeviceSession({ ...deviceSession, sessionCreatedAt: ago(FRESH_AUTH_WINDOW_MS + 1) }, NOW)).toBe(false);
  });

  it("is five minutes", () => {
    expect(FRESH_AUTH_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it("needs the creation time", () => {
    expect(isFreshDeviceSession(deviceSession, NOW)).toBe(false);
  });

  it.each(["unassured", "oauth_pending", "staff_passkey"])(
    "does not count a %s customer session, however new",
    (authenticationLevel) => {
      expect(
        isFreshDeviceSession({ population: "customer", authenticationLevel, sessionCreatedAt: ago(1000) }, NOW),
      ).toBe(false);
    },
  );

  it("does not count a session without an authentication level", () => {
    expect(isFreshDeviceSession({ population: "customer", sessionCreatedAt: ago(1000) }, NOW)).toBe(false);
  });

  it("does not count a staff or partner session", () => {
    expect(
      isFreshDeviceSession(
        { population: "staff_partner", authenticationLevel: "device_biometric", sessionCreatedAt: ago(1000) },
        NOW,
      ),
    ).toBe(false);
  });
});
