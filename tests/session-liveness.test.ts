import { describe, expect, it } from "vitest";

import {
  canSessionStillAuthenticate,
  type ProviderSessionFacts,
} from "../src/modules/auth/domain/session-liveness.js";

const MINUTE = 60_000;
const CREATED_AT = new Date("2026-11-12T10:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(CREATED_AT.getTime() + offsetMs);
}

// A device_biometric row as the lifetime plugin leaves it: expiresAt is the
// absolute end (created + 30 min), updatedAt is the last activity.
function deviceSession(overrides: Partial<ProviderSessionFacts> = {}): ProviderSessionFacts {
  return {
    authenticationLevel: "device_biometric",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    expiresAt: at(30 * MINUTE),
    ...overrides,
  };
}

function check(input: {
  status?: string;
  betterAuthSessionId?: string | null;
  providerSession: ProviderSessionFacts | null;
  now: Date;
}): boolean {
  return canSessionStillAuthenticate({
    status: input.status ?? "active",
    betterAuthSessionId: input.betterAuthSessionId === undefined ? "ba_01" : input.betterAuthSessionId,
    providerSession: input.providerSession,
    now: input.now,
  });
}

describe("canSessionStillAuthenticate", () => {
  describe("device_biometric sessions", () => {
    it("is live inside both the idle and the absolute limit", () => {
      expect(check({ providerSession: deviceSession(), now: at(4 * MINUTE) })).toBe(true);
    });

    it("ends at the idle limit even though better-auth's expiresAt is still in the future", () => {
      expect(check({ providerSession: deviceSession(), now: at(5 * MINUTE) })).toBe(false);
      expect(check({ providerSession: deviceSession(), now: at(6 * MINUTE) })).toBe(false);
    });

    it("counts activity: a session used at +4 min is still live at +8 min", () => {
      const session = deviceSession({ updatedAt: at(4 * MINUTE) });
      expect(check({ providerSession: session, now: at(8 * MINUTE) })).toBe(true);
    });

    it("ends at the absolute limit however recent the activity", () => {
      const session = deviceSession({ updatedAt: at(29 * MINUTE) });
      expect(check({ providerSession: session, now: at(30 * MINUTE) })).toBe(false);
    });
  });

  describe("other sessions", () => {
    it("judges only better-auth's own expiresAt, not the 5/30 minute device limits", () => {
      // Created 3 hours ago and idle for 2: far past anything a device session
      // allows, but better-auth's rolling expiry still has it live.
      const session: ProviderSessionFacts = {
        authenticationLevel: "oauth_pending",
        createdAt: at(-180 * MINUTE),
        updatedAt: at(-120 * MINUTE),
        expiresAt: at(10 * MINUTE),
      };
      expect(check({ providerSession: session, now: CREATED_AT })).toBe(true);
    });

    it("ends once expiresAt has passed", () => {
      const session: ProviderSessionFacts = {
        authenticationLevel: "staff_passkey",
        createdAt: at(-60 * MINUTE),
        updatedAt: at(-40 * MINUTE),
        expiresAt: at(-10 * MINUTE),
      };
      expect(check({ providerSession: session, now: CREATED_AT })).toBe(false);
    });
  });

  it("ends a session whose better-auth row is gone", () => {
    expect(check({ providerSession: null, now: CREATED_AT })).toBe(false);
  });

  it("leaves a session without a better-auth link alone, since there is nothing to check it against", () => {
    expect(check({ betterAuthSessionId: null, providerSession: null, now: CREATED_AT })).toBe(true);
  });

  it("only second-guesses sessions the mirror still calls active", () => {
    expect(check({ status: "revoked", providerSession: null, now: at(10 * MINUTE) })).toBe(true);
    expect(
      check({ status: "revoked", providerSession: deviceSession(), now: at(90 * MINUTE) }),
    ).toBe(true);
  });
});
