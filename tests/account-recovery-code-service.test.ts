import { describe, expect, it, vi } from "vitest";

import {
  RedeemAccountRecoveryCodeService,
  RotateAccountRecoveryCodeService,
} from "../src/modules/auth/application/account-recovery-code.service.js";
import type { CustomerAccountAdministrator } from "../src/modules/auth/application/customer-account-administrator.js";
import { hashAccountRecoveryCode } from "../src/modules/auth/domain/account-recovery-code.js";
import type { AccountRecoveryCodeRepository } from "../src/modules/auth/repository/account-recovery-code.repository.js";

const now = new Date("2026-09-06T10:00:00.000Z");
const hashKey = "test-hash-key";

function repository(
  overrides: Partial<AccountRecoveryCodeRepository> = {},
): AccountRecoveryCodeRepository {
  return {
    rotate: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ betterAuthUserId: "auth_01" }),
    ...overrides,
  };
}

function administrator(): CustomerAccountAdministrator {
  return {
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    sendRecoveryCompletionEmail: vi.fn().mockResolvedValue(undefined),
    prepareSelfServicePasskeyReplacement: vi.fn().mockResolvedValue("context_01"),
    revokeSessionsForRecoveryCompletion: vi.fn(),
    clearRecoveryRequired: vi.fn(),
  };
}

describe("account recovery codes", () => {
  it("returns the raw code once while storing only its HMAC", async () => {
    const codes = repository();
    const service = new RotateAccountRecoveryCodeService(codes, hashKey, () => now);

    const result = await service.execute("acct_01");

    expect(result.code).toMatch(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/);
    expect(result.createdAt).toEqual(now);
    expect(codes.rotate).toHaveBeenCalledWith({
      accountId: "acct_01",
      codeHash: hashAccountRecoveryCode(result.code, hashKey),
      createdAt: now,
    });
  });

  it("consumes the second factor before issuing a replacement-passkey context", async () => {
    const codes = repository();
    const accounts = administrator();
    const service = new RedeemAccountRecoveryCodeService(codes, accounts, hashKey, () => now);

    await expect(
      service.execute({ accountId: "acct_01", code: "AAAAA-BBBBB-CCCCC-DDDDD" }),
    ).resolves.toEqual({ passkeyRegistrationContext: "context_01" });

    expect(codes.consume).toHaveBeenCalledWith({
      accountId: "acct_01",
      codeHash: hashAccountRecoveryCode("AAAAA-BBBBB-CCCCC-DDDDD", hashKey),
      consumedAt: now,
    });
    expect(accounts.prepareSelfServicePasskeyReplacement).toHaveBeenCalledWith("auth_01");
  });

  it("rejects an invalid or already consumed code", async () => {
    const service = new RedeemAccountRecoveryCodeService(
      repository({ consume: vi.fn().mockResolvedValue(null) }),
      administrator(),
      hashKey,
      () => now,
    );

    const result = service.execute({
      accountId: "acct_01",
      code: "AAAAA-BBBBB-CCCCC-DDDDD",
    });

    await expect(result).rejects.toMatchObject({
      code: "authentication.account_recovery_code_invalid",
      status: 403,
    });
  });
});
