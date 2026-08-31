import { describe, expect, it, vi } from "vitest";

import type { StaffAccountAdministrator } from "../src/modules/auth/application/staff-account-administrator.js";
import {
  OffboardStaffAccountService,
  RecoverStaffAccountService,
} from "../src/modules/auth/application/staff-account-lifecycle.service.js";
import type { StaffAccountLifecycleRepository } from "../src/modules/auth/repository/staff-account-lifecycle.repository.js";

const now = new Date("2026-08-31T20:00:00.000Z");
const target = {
  accountId: "acct_staff",
  betterAuthUserId: "auth_staff",
  status: "active",
  hasActiveStaffRole: true,
};

function buildFakes() {
  const repository: StaffAccountLifecycleRepository = {
    findTarget: vi.fn().mockResolvedValue(target),
    prepareRecovery: vi.fn().mockResolvedValue(true),
    recordRecoveryDeliveryFailure: vi.fn().mockResolvedValue(undefined),
    completeOffboarding: vi.fn().mockResolvedValue(undefined),
  };
  const administrator: StaffAccountAdministrator = {
    prepareRecovery: vi.fn().mockResolvedValue(undefined),
    sendRecoveryEmail: vi.fn().mockResolvedValue(undefined),
    disableAndRevoke: vi.fn().mockResolvedValue(undefined),
  };
  return { repository, administrator };
}

describe("staff account lifecycle services", () => {
  it("revokes sessions and WebAuthn before sending a staff recovery email", async () => {
    const { repository, administrator } = buildFakes();
    const service = new RecoverStaffAccountService(
      repository,
      administrator,
      "https://app.example.test/staff/reset-password",
      () => now,
    );

    const result = await service.execute({
      accountId: target.accountId,
      actorAccountId: "acct_admin",
      traceId: "trace_recovery",
    });

    expect(result.data).toEqual({
      recovery_started: true,
      webauthn_reenrollment_required: true,
    });
    expect(administrator.prepareRecovery).toHaveBeenCalledWith({
      betterAuthUserId: "auth_staff",
      recoveryRequiredAt: now,
    });
    expect(repository.prepareRecovery).toHaveBeenCalledWith({
      accountId: "acct_staff",
      actorAccountId: "acct_admin",
      traceId: "trace_recovery",
      preparedAt: now,
    });
    expect(administrator.sendRecoveryEmail).toHaveBeenCalledWith({
      betterAuthUserId: "auth_staff",
      redirectTo: "https://app.example.test/staff/reset-password",
      traceId: "trace_recovery",
    });
    expect(vi.mocked(administrator.prepareRecovery).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(repository.prepareRecovery).mock.invocationCallOrder[0] ?? 0,
    );
    expect(vi.mocked(repository.prepareRecovery).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(administrator.sendRecoveryEmail).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("records a failed recovery delivery after access has already been revoked", async () => {
    const { repository, administrator } = buildFakes();
    vi.mocked(administrator.sendRecoveryEmail).mockRejectedValueOnce(
      new Error("SMTP unavailable"),
    );
    const service = new RecoverStaffAccountService(
      repository,
      administrator,
      "https://app.example.test/staff/reset-password",
      () => now,
    );

    await expect(
      service.execute({
        accountId: target.accountId,
        actorAccountId: "acct_admin",
        traceId: "trace_recovery",
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_recovery_delivery_failed",
      status: 503,
    });
    expect(repository.recordRecoveryDeliveryFailure).toHaveBeenCalledWith({
      accountId: "acct_staff",
      actorAccountId: "acct_admin",
      traceId: "trace_recovery",
      failedAt: now,
    });
  });

  it("rejects recovery when the target has no active staff role", async () => {
    const { repository, administrator } = buildFakes();
    vi.mocked(repository.findTarget).mockResolvedValueOnce({
      ...target,
      hasActiveStaffRole: false,
    });
    const service = new RecoverStaffAccountService(
      repository,
      administrator,
      "https://app.example.test/staff/reset-password",
    );

    await expect(
      service.execute({
        accountId: target.accountId,
        actorAccountId: "acct_admin",
        traceId: "trace_recovery",
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_account_target_unavailable",
      status: 409,
    });
    expect(administrator.prepareRecovery).not.toHaveBeenCalled();
  });

  it("disables the Better Auth identity before completing offboarding", async () => {
    const { repository, administrator } = buildFakes();
    const service = new OffboardStaffAccountService(repository, administrator, () => now);

    const result = await service.execute({
      accountId: target.accountId,
      actorAccountId: "acct_admin",
      traceId: "trace_offboard",
      reason: "partner_firm_notice",
    });

    expect(result.data).toEqual({ offboarded: true });
    expect(administrator.disableAndRevoke).toHaveBeenCalledWith({
      betterAuthUserId: "auth_staff",
      reason: "partner_firm_notice",
      disabledAt: now,
    });
    expect(repository.completeOffboarding).toHaveBeenCalledWith({
      accountId: "acct_staff",
      actorAccountId: "acct_admin",
      traceId: "trace_offboard",
      reason: "partner_firm_notice",
      completedAt: now,
    });
    expect(
      vi.mocked(administrator.disableAndRevoke).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(repository.completeOffboarding).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not permit an administrator to recover or offboard themselves", async () => {
    const { repository, administrator } = buildFakes();
    const recovery = new RecoverStaffAccountService(
      repository,
      administrator,
      "https://app.example.test/staff/reset-password",
    );
    const offboarding = new OffboardStaffAccountService(repository, administrator);
    const action = {
      accountId: "acct_admin",
      actorAccountId: "acct_admin",
      traceId: "trace_self",
    };

    await expect(recovery.execute(action)).rejects.toMatchObject({
      code: "authentication.staff_account_self_action_forbidden",
      status: 403,
    });
    await expect(
      offboarding.execute({ ...action, reason: "security_action" }),
    ).rejects.toMatchObject({
      code: "authentication.staff_account_self_action_forbidden",
      status: 403,
    });
    expect(repository.findTarget).not.toHaveBeenCalled();
  });
});
