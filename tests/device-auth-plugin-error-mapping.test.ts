import { describe, expect, it, vi } from "vitest";

import {
  AndroidAttestationChallengeMismatchError,
  AndroidAttestationInvalidError,
} from "../src/modules/auth/application/android-attestation-verifier.js";
import {
  DeviceAlreadyEnrolledError,
  DeviceChallengeExpiredError,
  DeviceLoginFailedError,
} from "../src/modules/auth/application/device-auth-errors.js";
import {
  DeviceChallengePurposeMismatchError,
  DeviceJwsDpopMismatchError,
  DeviceJwsInvalidError,
} from "../src/modules/auth/application/device-auth-jws-verifier.js";
import {
  accountRestricted,
  logAttestationRejection,
  toApiError,
} from "../src/modules/auth/infrastructure/better-auth-device-auth.plugin.js";

// Contract section 3.6's table is the source of truth for these -- not a
// blanket 401. Getting this wrong previously meant every device-auth
// rejection surfaced as 401 regardless of what actually went wrong.
describe("better-auth-device-auth.plugin's toApiError mapping (contract 3.6)", () => {
  const cases: Array<{ error: Error; status: number; code: string }> = [
    { error: new DeviceChallengeExpiredError(), status: 400, code: "DEVICE_CHALLENGE_EXPIRED" },
    {
      error: new DeviceChallengePurposeMismatchError(),
      status: 400,
      code: "DEVICE_CHALLENGE_PURPOSE_MISMATCH",
    },
    { error: new DeviceJwsInvalidError("reason"), status: 400, code: "DEVICE_JWS_INVALID" },
    { error: new DeviceJwsDpopMismatchError(), status: 400, code: "DEVICE_JWS_INVALID" },
    { error: new AndroidAttestationInvalidError("reason"), status: 400, code: "ATTESTATION_INVALID" },
    {
      error: new AndroidAttestationChallengeMismatchError(),
      status: 400,
      code: "ATTESTATION_CHALLENGE_MISMATCH",
    },
    { error: new DeviceAlreadyEnrolledError(), status: 409, code: "DEVICE_ALREADY_ENROLLED" },
    { error: new DeviceLoginFailedError(), status: 401, code: "DEVICE_LOGIN_FAILED" },
  ];

  for (const { error, status, code } of cases) {
    it(`maps ${error.constructor.name} to ${status}`, () => {
      const apiError = toApiError(error);
      expect(apiError.statusCode).toBe(status);
      expect(apiError.body).toMatchObject({ code });
    });
  }

  it("never leaks an AndroidAttestationInvalidError's specific internal reason to the response -- it's an oracle a forger could use to iterate towards a passing chain", () => {
    const apiError = toApiError(
      new AndroidAttestationInvalidError("the leaf's issuer name does not match the next cert's subject"),
    );
    expect(String(apiError.body?.message)).not.toContain("issuer name");
  });

  it("never leaks an AndroidAttestationChallengeMismatchError's specific internal reason either", () => {
    const apiError = toApiError(new AndroidAttestationChallengeMismatchError());
    expect(String(apiError.body?.message)).not.toContain("binding");
  });

  it("re-throws an error it doesn't recognize instead of swallowing it as a generic failure", () => {
    expect(() => toApiError(new Error("something unrelated"))).toThrow("something unrelated");
  });
});

describe("logAttestationRejection", () => {
  it("logs an Android attestation error's specific reason server-side, even though the client never sees it", () => {
    const warn = vi.fn();
    const ctx = { context: { logger: { warn } }, path: "/device/enrol/verify" };

    logAttestationRejection(ctx, new AndroidAttestationInvalidError("the app-signing certificate is not on the allowlist"));

    expect(warn).toHaveBeenCalledWith(
      "device-auth attestation rejected",
      expect.objectContaining({
        code: "ATTESTATION_INVALID",
        reason: expect.stringContaining("app-signing certificate"),
        path: "/device/enrol/verify",
      }),
    );
  });

  it("does nothing for a non-attestation error", () => {
    const warn = vi.fn();
    const ctx = { context: { logger: { warn } } };

    logAttestationRejection(ctx, new DeviceChallengeExpiredError());

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not throw when no logger is configured", () => {
    expect(() =>
      logAttestationRejection({ context: {} }, new AndroidAttestationInvalidError("reason")),
    ).not.toThrow();
  });
});

// A closed/suspended account's devices otherwise stay fully able to
// enrol/log in -- device status and account status are entirely separate,
// so E2/L2 both check the account explicitly (better-auth-device-auth
// .plugin.ts's enrolVerify/loginVerify handlers).
describe("accountRestricted", () => {
  it("is a 403 with the contract's ACCOUNT_RESTRICTED code", () => {
    const error = accountRestricted();
    expect(error.statusCode).toBe(403);
    expect(error.body).toMatchObject({ code: "ACCOUNT_RESTRICTED" });
  });
});
