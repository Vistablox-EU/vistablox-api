import { describe, expect, it, vi } from "vitest";

import type { StaffAccountAdministrator } from "../src/modules/auth/application/staff-account-administrator.js";
import {
  GrantStaffRoleService,
  ListStaffAccountsService,
  OffboardStaffAccountService,
  RecoverStaffAccountService,
  RevokeStaffRoleService,
} from "../src/modules/auth/application/staff-account-lifecycle.service.js";
import type { StaffAccountLifecycleRepository } from "../src/modules/auth/repository/staff-account-lifecycle.repository.js";

const now = new Date("2026-08-31T20:00:00.000Z");
const target = {
  accountId: "acct_staff",
  betterAuthUserId: "auth_staff",
  status: "active",
  hasActiveStaffRole: true,
};
const assignment = {
  assignmentId: "role_01",
  role: "legal_partner" as const,
  legalPracticeId: "practice_01",
  appraisalFirmId: null,
  grantedAt: now,
  revokedAt: null,
};

function buildFakes() {
  const repository: StaffAccountLifecycleRepository = {
    findTarget: vi.fn().mockResolvedValue(target),
    prepareRecovery: vi.fn().mockResolvedValue(true),
    recordRecoveryDeliveryFailure: vi.fn().mockResolvedValue(undefined),
    completeOffboarding: vi.fn().mockResolvedValue(undefined),
    listStaffAccounts: vi.fn().mockResolvedValue([]),
    hasActiveRole: vi.fn().mockResolvedValue(false),
    grantRole: vi.fn().mockResolvedValue(assignment),
    revokeRole: vi.fn().mockResolvedValue(assignment),
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

describe("staff account roster", () => {
  it("maps every account's role history to the wire shape", async () => {
    const { repository } = buildFakes();
    vi.mocked(repository.listStaffAccounts).mockResolvedValueOnce([
      {
        accountId: "acct_staff",
        email: "staff@example.test",
        status: "active",
        roles: [
          assignment,
          { ...assignment, assignmentId: "role_00", revokedAt: new Date("2026-08-01T00:00:00.000Z") },
        ],
      },
    ]);
    const service = new ListStaffAccountsService(repository);

    const result = await service.execute();

    expect(result.data).toEqual([
      {
        account_id: "acct_staff",
        email: "staff@example.test",
        status: "active",
        roles: [
          {
            assignment_id: "role_01",
            role: "legal_partner",
            legal_practice_id: "practice_01",
            appraisal_firm_id: null,
            granted_at: now.toISOString(),
            revoked_at: null,
          },
          {
            assignment_id: "role_00",
            role: "legal_partner",
            legal_practice_id: "practice_01",
            appraisal_firm_id: null,
            granted_at: now.toISOString(),
            revoked_at: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
    ]);
  });
});

describe("staff role grants", () => {
  it("grants an additional role to an already-active staff account", async () => {
    const { repository } = buildFakes();
    const service = new GrantStaffRoleService(repository, () => now);

    const result = await service.execute({
      accountId: target.accountId,
      actorAccountId: "acct_admin",
      traceId: "trace_grant",
      role: "legal_partner",
      legalPracticeId: "practice_01",
      appraisalFirmId: null,
    });

    expect(result.data).toMatchObject({ assignment_id: "role_01", role: "legal_partner" });
    expect(repository.hasActiveRole).toHaveBeenCalledWith({
      accountId: "acct_staff",
      role: "legal_partner",
    });
    expect(repository.grantRole).toHaveBeenCalledWith({
      accountId: "acct_staff",
      role: "legal_partner",
      legalPracticeId: "practice_01",
      appraisalFirmId: null,
      actorAccountId: "acct_admin",
      traceId: "trace_grant",
      grantedAt: now,
    });
  });

  it("rejects granting a role the account already actively holds", async () => {
    const { repository } = buildFakes();
    vi.mocked(repository.hasActiveRole).mockResolvedValueOnce(true);
    const service = new GrantStaffRoleService(repository, () => now);

    await expect(
      service.execute({
        accountId: target.accountId,
        actorAccountId: "acct_admin",
        traceId: "trace_grant",
        role: "legal_partner",
        legalPracticeId: "practice_01",
        appraisalFirmId: null,
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_role_already_granted",
      status: 409,
    });
    expect(repository.grantRole).not.toHaveBeenCalled();
  });

  it("rejects granting a role to an account that is not an active staff member", async () => {
    const { repository } = buildFakes();
    vi.mocked(repository.findTarget).mockResolvedValueOnce({
      ...target,
      hasActiveStaffRole: false,
    });
    const service = new GrantStaffRoleService(repository, () => now);

    await expect(
      service.execute({
        accountId: target.accountId,
        actorAccountId: "acct_admin",
        traceId: "trace_grant",
        role: "legal_partner",
        legalPracticeId: "practice_01",
        appraisalFirmId: null,
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_account_target_unavailable",
      status: 409,
    });
    expect(repository.hasActiveRole).not.toHaveBeenCalled();
  });

  it("does not permit an administrator to grant themselves a role", async () => {
    const { repository } = buildFakes();
    const service = new GrantStaffRoleService(repository, () => now);

    await expect(
      service.execute({
        accountId: "acct_admin",
        actorAccountId: "acct_admin",
        traceId: "trace_grant",
        role: "legal_partner",
        legalPracticeId: "practice_01",
        appraisalFirmId: null,
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_account_self_action_forbidden",
      status: 403,
    });
    expect(repository.findTarget).not.toHaveBeenCalled();
  });
});

describe("staff role revocation", () => {
  it("revokes a single role assignment without touching the rest of the account", async () => {
    const { repository } = buildFakes();
    const service = new RevokeStaffRoleService(repository, () => now);

    const result = await service.execute({
      accountId: target.accountId,
      assignmentId: "role_01",
      actorAccountId: "acct_admin",
      traceId: "trace_revoke",
    });

    expect(result.data).toEqual({ revoked: true });
    expect(repository.revokeRole).toHaveBeenCalledWith({
      accountId: "acct_staff",
      assignmentId: "role_01",
      actorAccountId: "acct_admin",
      traceId: "trace_revoke",
      revokedAt: now,
    });
  });

  it("reports a conflict when the assignment is already revoked or does not belong to the account", async () => {
    const { repository } = buildFakes();
    vi.mocked(repository.revokeRole).mockResolvedValueOnce(null);
    const service = new RevokeStaffRoleService(repository, () => now);

    await expect(
      service.execute({
        accountId: target.accountId,
        assignmentId: "role_missing",
        actorAccountId: "acct_admin",
        traceId: "trace_revoke",
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_account_target_unavailable",
      status: 409,
    });
  });

  it("does not permit an administrator to revoke their own role", async () => {
    const { repository } = buildFakes();
    const service = new RevokeStaffRoleService(repository, () => now);

    await expect(
      service.execute({
        accountId: "acct_admin",
        assignmentId: "role_01",
        actorAccountId: "acct_admin",
        traceId: "trace_revoke",
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_account_self_action_forbidden",
      status: 403,
    });
    expect(repository.revokeRole).not.toHaveBeenCalled();
  });
});
