import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { BootstrapFirstAdminService } from "../src/modules/auth/application/staff-bootstrap.service.js";
import type { StaffIdentityProvider } from "../src/modules/auth/application/staff-identity-provider.js";
import type {
  StaffBootstrapCounts,
  StaffBootstrapRepository,
} from "../src/modules/auth/repository/staff-bootstrap.repository.js";

const now = new Date("2026-09-12T10:00:00.000Z");
const acceptUrl = "https://admin.example.test/staff/accept-invitation";
const noAdmin: StaffBootstrapCounts = {
  activeStaffAccounts: 0,
  activeAdminOperationsHolders: 0,
  pendingBootstrapInvitations: 0,
};

function buildFakes(counts: StaffBootstrapCounts = noAdmin) {
  const repository: StaffBootstrapRepository = {
    countBootstrapState: vi.fn().mockResolvedValue(counts),
    issueBootstrapInvitation: vi.fn().mockImplementation(async (input: { expiresAt: Date }) => ({
      outcome: "issued",
      invitationId: "invite_bootstrap",
      expiresAt: input.expiresAt,
      replacedPendingBootstrapInvitations: 0,
      revokedInvitations: 0,
    })),
  };
  const identities: StaffIdentityProvider = {
    assertEmailAvailable: vi.fn().mockResolvedValue(undefined),
    createOrResolveInvitedStaff: vi.fn(),
  };
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  const service = new BootstrapFirstAdminService(
    repository,
    identities,
    sendEmail,
    acceptUrl,
    () => now,
  );
  return { repository, identities, sendEmail, service };
}

function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get("token");
  if (token === null) throw new Error("no token in URL");
  return token;
}

describe("BootstrapFirstAdminService", () => {
  it("check() only reads counts", async () => {
    const { repository, identities, sendEmail, service } = buildFakes();
    await expect(service.check()).resolves.toEqual(noAdmin);
    expect(repository.issueBootstrapInvitation).not.toHaveBeenCalled();
    expect(identities.assertEmailAvailable).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses before touching anything when an active admin already exists", async () => {
    const { repository, identities, sendEmail, service } = buildFakes({
      activeStaffAccounts: 1,
      activeAdminOperationsHolders: 1,
      pendingBootstrapInvitations: 0,
    });
    await expect(
      service.issue({ email: "a@example.test", displayName: "A", traceId: "trace" }),
    ).resolves.toEqual({ outcome: "refused_admin_exists" });
    expect(identities.assertEmailAvailable).not.toHaveBeenCalled();
    expect(repository.issueBootstrapInvitation).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses without emailing when the locked re-check finds an admin", async () => {
    const { repository, sendEmail, service } = buildFakes();
    vi.mocked(repository.issueBootstrapInvitation).mockResolvedValueOnce({
      outcome: "admin_exists",
    });
    await expect(
      service.issue({ email: "a@example.test", displayName: "A", traceId: "trace" }),
    ).resolves.toEqual({ outcome: "refused_admin_exists" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("issues a normal 72-hour invitation, storing only the token's hash", async () => {
    const { repository, identities, sendEmail, service } = buildFakes();
    const result = await service.issue({
      email: " First.Admin@Example.Test ",
      displayName: " First Admin ",
      traceId: "trace_bootstrap",
    });

    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") return;
    expect(identities.assertEmailAvailable).toHaveBeenCalledWith("first.admin@example.test");
    expect(result.invitationUrl).toMatch(
      /^https:\/\/admin\.example\.test\/staff\/accept-invitation\?token=[A-Za-z0-9_-]{43}$/,
    );
    const token = tokenOf(result.invitationUrl);
    const stored = vi.mocked(repository.issueBootstrapInvitation).mock.calls[0]?.[0];
    expect(stored).toEqual({
      email: "first.admin@example.test",
      displayName: "First Admin",
      tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
      traceId: "trace_bootstrap",
      createdAt: now,
      expiresAt: new Date("2026-09-15T10:00:00.000Z"),
    });
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(sendEmail).toHaveBeenCalledWith({
      to: "first.admin@example.test",
      displayName: "First Admin",
      invitationUrl: result.invitationUrl,
      expiresAt: new Date("2026-09-15T10:00:00.000Z"),
    });
    expect(result.emailDelivery).toEqual({ delivered: true });
  });

  it("keeps the invitation when email fails and reports only an error code", async () => {
    const { repository, sendEmail, service } = buildFakes();
    sendEmail.mockImplementationOnce(async (input: { invitationUrl: string }) => {
      throw Object.assign(new Error(`SMTP rejected message body ${input.invitationUrl}`), {
        code: "EENVELOPE",
      });
    });
    const result = await service.issue({
      email: "a@example.test",
      displayName: "A",
      traceId: "trace",
    });
    expect(result).toMatchObject({
      outcome: "issued",
      emailDelivery: { delivered: false, errorCode: "EENVELOPE" },
    });
    if (result.outcome !== "issued") return;
    expect(JSON.stringify(result.emailDelivery)).not.toContain(tokenOf(result.invitationUrl));
    expect(repository.issueBootstrapInvitation).toHaveBeenCalledTimes(1);
  });

  it("propagates an email that already belongs to an identity without issuing", async () => {
    const { repository, identities, service } = buildFakes();
    vi.mocked(identities.assertEmailAvailable).mockRejectedValueOnce(new Error("taken"));
    await expect(
      service.issue({ email: "a@example.test", displayName: "A", traceId: "trace" }),
    ).rejects.toThrow("taken");
    expect(repository.issueBootstrapInvitation).not.toHaveBeenCalled();
  });
});
