import { describe, expect, it, vi } from "vitest";

import type { StaffIdentityProvider } from "../src/modules/auth/application/staff-identity-provider.js";
import {
  AcceptStaffInvitationService,
  IssueStaffInvitationService,
} from "../src/modules/auth/application/staff-invitation.service.js";
import type {
  StaffInvitationRecord,
  StaffInvitationRepository,
} from "../src/modules/auth/repository/staff-invitation.repository.js";

const now = new Date("2026-08-31T18:30:00.000Z");
const invitation: StaffInvitationRecord = {
  invitationId: "invite_01",
  email: "new.staff@example.test",
  displayName: "New Staff",
  role: "admin_operations",
  legalPracticeId: null,
  appraisalFirmId: null,
  tokenHash: "a".repeat(64),
  claimId: null,
  expiresAt: new Date("2026-09-03T18:30:00.000Z"),
};

function buildFakes() {
  const repository: StaffInvitationRepository = {
    createInvitation: vi.fn().mockResolvedValue(invitation),
    revokeInvitation: vi.fn().mockResolvedValue(undefined),
    claimInvitation: vi.fn().mockResolvedValue({ ...invitation, claimId: "claimed" }),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
    completeAcceptance: vi.fn().mockResolvedValue({ accountId: "acct_invited" }),
  };
  const identities: StaffIdentityProvider = {
    assertEmailAvailable: vi.fn().mockResolvedValue(undefined),
    createOrResolveInvitedStaff: vi
      .fn()
      .mockResolvedValue({
        betterAuthUserId: "auth_invited",
        passkeyRegistrationContext: "bootstrap_context_that_is_long_enough",
      }),
  };
  return { repository, identities };
}

describe("staff invitation services", () => {
  it("issues a normalized, hashed, 72-hour invitation without returning its token", async () => {
    const { repository, identities } = buildFakes();
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const service = new IssueStaffInvitationService(
      repository,
      identities,
      sendEmail,
      "https://app.example.test/staff/accept",
      () => now,
    );

    const result = await service.execute({
      actorAccountId: "acct_admin",
      traceId: "trace_issue",
      email: " New.Staff@Example.Test ",
      displayName: "New Staff",
      role: "admin_operations",
      legalPracticeId: null,
      appraisalFirmId: null,
    });

    expect(result.data).toEqual({
      invitation_id: "invite_01",
      expires_at: "2026-09-03T18:30:00.000Z",
    });
    expect(repository.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "new.staff@example.test",
        tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: new Date("2026-09-03T18:30:00.000Z"),
      }),
    );
    const email = vi.mocked(sendEmail).mock.calls[0]?.[0];
    expect(email?.invitationUrl).toMatch(
      /^https:\/\/app\.example\.test\/staff\/accept\?token=[A-Za-z0-9_-]{43}$/,
    );
    expect(email?.invitationUrl).not.toContain(invitation.tokenHash);
  });

  it("revokes an invitation whose email delivery fails", async () => {
    const { repository, identities } = buildFakes();
    const service = new IssueStaffInvitationService(
      repository,
      identities,
      vi.fn().mockRejectedValue(new Error("SMTP unavailable")),
      "https://app.example.test/staff/accept",
      () => now,
    );

    await expect(
      service.execute({
        actorAccountId: "acct_admin",
        traceId: "trace_issue",
        email: invitation.email,
        displayName: invitation.displayName,
        role: invitation.role,
        legalPracticeId: null,
        appraisalFirmId: null,
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_invitation_delivery_failed",
      status: 503,
    });
    expect(repository.revokeInvitation).toHaveBeenCalledWith({
      invitationId: invitation.invitationId,
      actorAccountId: "acct_admin",
      traceId: "trace_issue",
      revokedAt: now,
      reason: "delivery_failed",
    });
  });

  it("accepts a claimed invitation and requires WebAuthn enrollment", async () => {
    const { repository, identities } = buildFakes();
    const service = new AcceptStaffInvitationService(repository, identities, () => now);

    const result = await service.execute({
      token: "raw_invitation_token_that_is_never_stored",
      traceId: "trace_accept",
    });

    expect(result.data).toEqual({
      accepted: true,
      account_id: "acct_invited",
      webauthn_enrollment_required: true,
      passkey_registration_context: "bootstrap_context_that_is_long_enough",
    });
    expect(identities.createOrResolveInvitedStaff).toHaveBeenCalledWith({
      email: invitation.email,
      displayName: invitation.displayName,
    });
    expect(repository.completeAcceptance).toHaveBeenCalledWith(
      expect.objectContaining({
        invitationId: invitation.invitationId,
        betterAuthUserId: "auth_invited",
        traceId: "trace_accept",
      }),
    );
  });

  it("rejects an unavailable token before creating an identity", async () => {
    const { repository, identities } = buildFakes();
    vi.mocked(repository.claimInvitation).mockResolvedValueOnce(null);
    const service = new AcceptStaffInvitationService(repository, identities, () => now);

    await expect(
      service.execute({
        token: "unavailable_invitation_token_value",
        traceId: "trace_accept",
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_invitation_unavailable",
      status: 409,
    });
    expect(identities.createOrResolveInvitedStaff).not.toHaveBeenCalled();
  });

  it("releases the claim when identity creation fails", async () => {
    const { repository, identities } = buildFakes();
    vi.mocked(identities.createOrResolveInvitedStaff).mockRejectedValueOnce(
      new Error("identity creation failed"),
    );
    const service = new AcceptStaffInvitationService(repository, identities, () => now);

    await expect(
      service.execute({
        token: "retryable_invitation_token_value",
        traceId: "trace_accept",
      }),
    ).rejects.toThrow("identity creation failed");
    expect(repository.releaseClaim).toHaveBeenCalledWith({
      invitationId: invitation.invitationId,
      claimId: expect.any(String),
    });
  });
});
