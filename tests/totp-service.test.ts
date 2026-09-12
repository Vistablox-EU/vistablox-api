import { describe, expect, it, vi } from "vitest";

import { EnrollTotpService, VerifyTotpService } from "../src/modules/auth/application/totp.service.js";
import type { TotpProvider } from "../src/modules/auth/infrastructure/otplib-totp.provider.js";
import type { TotpFactorRecord, TotpRepository } from "../src/modules/auth/repository/totp.repository.js";

function repository(overrides: Partial<TotpRepository> = {}): TotpRepository {
  return {
    getAccountLabel: vi.fn().mockResolvedValue("investor@example.com"),
    getFactor: vi.fn().mockResolvedValue(null),
    enroll: vi.fn().mockResolvedValue(undefined),
    recordTotpUse: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function provider(overrides: Partial<TotpProvider> = {}): TotpProvider {
  return {
    generateSecret: vi.fn().mockReturnValue("SECRET123"),
    verify: vi.fn().mockResolvedValue(false),
    buildOtpAuthUri: vi.fn().mockReturnValue("otpauth://totp/VistaBlox:investor@example.com?secret=SECRET123"),
    ...overrides,
  };
}

const factor: TotpFactorRecord = {
  accountId: "acct_01",
  secret: "SECRET123",
  enrolledAt: new Date("2026-08-01T00:00:00.000Z"),
  lastUsedAt: null,
};

describe("EnrollTotpService", () => {
  it("persists a fresh secret and returns the otpauth URI and secret, with no backup codes", async () => {
    const enroll = vi.fn().mockResolvedValue(undefined);
    const service = new EnrollTotpService(repository({ enroll }), provider(), () =>
      new Date("2026-09-01T12:00:00.000Z"),
    );

    const result = await service.execute("acct_01");

    expect(result).toEqual({
      otpAuthUri: "otpauth://totp/VistaBlox:investor@example.com?secret=SECRET123",
      secret: "SECRET123",
    });
    expect(enroll).toHaveBeenCalledWith({
      accountId: "acct_01",
      secret: "SECRET123",
      enrolledAt: new Date("2026-09-01T12:00:00.000Z"),
    });
  });
});

describe("VerifyTotpService", () => {
  it("rejects verification when no factor is enrolled", async () => {
    const service = new VerifyTotpService(repository({ getFactor: vi.fn().mockResolvedValue(null) }), provider());

    await expect(service.execute("acct_01", "123456")).rejects.toMatchObject({
      code: "auth.totp_not_enrolled",
      status: 409,
    });
  });

  it("accepts a valid TOTP code, records its use and marks the session fresh", async () => {
    const recordTotpUse = vi.fn().mockResolvedValue(undefined);
    const recordSessionFreshAuth = vi.fn().mockResolvedValue(undefined);
    const service = new VerifyTotpService(
      repository({ getFactor: vi.fn().mockResolvedValue(factor), recordTotpUse, recordSessionFreshAuth }),
      provider({ verify: vi.fn().mockResolvedValue(true) }),
      () => new Date("2026-09-01T12:00:00.000Z"),
    );

    const result = await service.execute("acct_01", "654321", "session_01");

    expect(result).toEqual({ verified: true, method: "totp" });
    expect(recordTotpUse).toHaveBeenCalledWith("acct_01", new Date("2026-09-01T12:00:00.000Z"));
    expect(recordSessionFreshAuth).toHaveBeenCalledWith({
      accountId: "acct_01",
      providerSessionId: "session_01",
      verifiedAt: new Date("2026-09-01T12:00:00.000Z"),
    });
  });

  it("rejects a code the authenticator didn't produce, with no backup-code fallback and no fresh-auth", async () => {
    const recordTotpUse = vi.fn().mockResolvedValue(undefined);
    const recordSessionFreshAuth = vi.fn().mockResolvedValue(undefined);
    const service = new VerifyTotpService(
      repository({ getFactor: vi.fn().mockResolvedValue(factor), recordTotpUse, recordSessionFreshAuth }),
      provider({ verify: vi.fn().mockResolvedValue(false) }),
    );

    // Formerly accepted as a one-time backup code.
    const result = await service.execute("acct_01", "ABCDE-FGHJK", "session_01");

    expect(result).toEqual({ verified: false, method: null });
    expect(recordTotpUse).not.toHaveBeenCalled();
    expect(recordSessionFreshAuth).not.toHaveBeenCalled();
  });
});
