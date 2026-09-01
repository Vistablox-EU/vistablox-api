import { describe, expect, it, vi } from "vitest";

import { EnrollTotpService, VerifyTotpService } from "../src/modules/auth/application/totp.service.js";
import { hashBackupCode } from "../src/modules/auth/domain/totp-policy.js";
import type { TotpProvider } from "../src/modules/auth/infrastructure/otplib-totp.provider.js";
import type { TotpFactorRecord, TotpRepository } from "../src/modules/auth/repository/totp.repository.js";

const hashKey = "test-hash-key";

function repository(overrides: Partial<TotpRepository> = {}): TotpRepository {
  return {
    getAccountLabel: vi.fn().mockResolvedValue("investor@example.com"),
    getFactor: vi.fn().mockResolvedValue(null),
    enroll: vi.fn().mockResolvedValue(undefined),
    recordTotpUse: vi.fn().mockResolvedValue(undefined),
    countUnconsumedBackupCodes: vi.fn().mockResolvedValue(0),
    consumeBackupCode: vi.fn().mockResolvedValue(false),
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

describe("EnrollTotpService", () => {
  it("persists a fresh secret and ten hashed backup codes, returning the plaintext codes once", async () => {
    const enroll = vi.fn().mockResolvedValue(undefined);
    const service = new EnrollTotpService(repository({ enroll }), provider(), hashKey, () =>
      new Date("2026-09-01T12:00:00.000Z"),
    );

    const result = await service.execute("acct_01");

    expect(result.backupCodes).toHaveLength(10);
    expect(result.otpAuthUri).toContain("otpauth://");
    expect(enroll).toHaveBeenCalledWith({
      accountId: "acct_01",
      secret: "SECRET123",
      backupCodeHashes: result.backupCodes.map((code) => hashBackupCode(code, hashKey)),
      enrolledAt: new Date("2026-09-01T12:00:00.000Z"),
    });
  });
});

describe("VerifyTotpService", () => {
  it("rejects verification when no factor is enrolled", async () => {
    const service = new VerifyTotpService(repository({ getFactor: vi.fn().mockResolvedValue(null) }), provider(), hashKey);

    await expect(service.execute("acct_01", "123456")).rejects.toMatchObject({
      code: "auth.totp_not_enrolled",
      status: 409,
    });
  });

  it("accepts a valid TOTP code and records its use", async () => {
    const factor: TotpFactorRecord = {
      accountId: "acct_01",
      secret: "SECRET123",
      enrolledAt: new Date("2026-08-01T00:00:00.000Z"),
      lastUsedAt: null,
    };
    const recordTotpUse = vi.fn().mockResolvedValue(undefined);
    const service = new VerifyTotpService(
      repository({ getFactor: vi.fn().mockResolvedValue(factor), recordTotpUse }),
      provider({ verify: vi.fn().mockResolvedValue(true) }),
      hashKey,
      () => new Date("2026-09-01T12:00:00.000Z"),
    );

    const result = await service.execute("acct_01", "654321");

    expect(result).toEqual({ verified: true, method: "totp" });
    expect(recordTotpUse).toHaveBeenCalledWith("acct_01", new Date("2026-09-01T12:00:00.000Z"));
  });

  it("falls back to a backup code when the TOTP code does not match", async () => {
    const factor: TotpFactorRecord = {
      accountId: "acct_01",
      secret: "SECRET123",
      enrolledAt: new Date("2026-08-01T00:00:00.000Z"),
      lastUsedAt: null,
    };
    const consumeBackupCode = vi.fn().mockResolvedValue(true);
    const service = new VerifyTotpService(
      repository({ getFactor: vi.fn().mockResolvedValue(factor), consumeBackupCode }),
      provider({ verify: vi.fn().mockResolvedValue(false) }),
      hashKey,
      () => new Date("2026-09-01T12:00:00.000Z"),
    );

    const result = await service.execute("acct_01", " abcde-fghjk ");

    expect(result).toEqual({ verified: true, method: "backup_code" });
    expect(consumeBackupCode).toHaveBeenCalledWith({
      accountId: "acct_01",
      codeHash: hashBackupCode("ABCDE-FGHJK", hashKey),
      consumedAt: new Date("2026-09-01T12:00:00.000Z"),
    });
  });

  it("reports failure when neither the TOTP code nor a backup code matches", async () => {
    const factor: TotpFactorRecord = {
      accountId: "acct_01",
      secret: "SECRET123",
      enrolledAt: new Date("2026-08-01T00:00:00.000Z"),
      lastUsedAt: null,
    };
    const service = new VerifyTotpService(
      repository({ getFactor: vi.fn().mockResolvedValue(factor) }),
      provider(),
      hashKey,
    );

    const result = await service.execute("acct_01", "000000");

    expect(result).toEqual({ verified: false, method: null });
  });
});
