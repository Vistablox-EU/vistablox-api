import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import type { StaffInvitationRepository, StaffRole } from "../repository/staff-invitation.repository.js";
import type { StaffIdentityProvider } from "./staff-identity-provider.js";

const invitationLifetimeMs = 72 * 60 * 60 * 1000;
const abandonedClaimLifetimeMs = 10 * 60 * 1000;

export class IssueStaffInvitationService {
  public constructor(
    private readonly repository: StaffInvitationRepository,
    private readonly identities: StaffIdentityProvider,
    private readonly sendInvitationEmail: (input: {
      to: string;
      displayName: string;
      invitationUrl: string;
      expiresAt: Date;
    }) => Promise<void>,
    private readonly invitationAcceptUrl: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    actorAccountId: string;
    traceId: string;
    email: string;
    displayName: string;
    role: StaffRole;
    legalPracticeId: string | null;
    appraisalFirmId: string | null;
  }) {
    const email = input.email.trim().toLowerCase();
    await this.identities.assertEmailAvailable(email);
    const rawToken = randomBytes(32).toString("base64url");
    const createdAt = this.clock();
    const invitation = await this.repository.createInvitation({
      email,
      displayName: input.displayName,
      role: input.role,
      legalPracticeId: input.legalPracticeId,
      appraisalFirmId: input.appraisalFirmId,
      tokenHash: hashToken(rawToken),
      invitedByAccountId: input.actorAccountId,
      traceId: input.traceId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + invitationLifetimeMs),
    });

    try {
      await this.sendInvitationEmail({
        to: email,
        displayName: input.displayName,
        invitationUrl: withToken(this.invitationAcceptUrl, rawToken),
        expiresAt: invitation.expiresAt,
      });
    } catch (error) {
      await this.repository.revokeInvitation({
        invitationId: invitation.invitationId,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        revokedAt: this.clock(),
        reason: "delivery_failed",
      });
      throw new AppError({
        code: "authentication.staff_invitation_delivery_failed",
        title: "Staff invitation could not be delivered",
        status: 503,
        detail: "The invitation was revoked because its email could not be delivered.",
        cause: error,
      });
    }
    return {
      data: {
        invitation_id: invitation.invitationId,
        expires_at: invitation.expiresAt.toISOString(),
      },
    };
  }
}

export class AcceptStaffInvitationService {
  public constructor(
    private readonly repository: StaffInvitationRepository,
    private readonly identities: StaffIdentityProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: { token: string; password: string; traceId: string }) {
    const claimedAt = this.clock();
    const claimId = randomUUID();
    const invitation = await this.repository.claimInvitation({
      tokenHash: hashToken(input.token),
      claimId,
      claimedAt,
      staleBefore: new Date(claimedAt.getTime() - abandonedClaimLifetimeMs),
    });
    if (invitation === null) throw unavailableInvitationError();

    try {
      const identity = await this.identities.createOrResolveInvitedStaff({
        email: invitation.email,
        displayName: invitation.displayName,
        password: input.password,
      });
      const accepted = await this.repository.completeAcceptance({
        invitationId: invitation.invitationId,
        claimId,
        betterAuthUserId: identity.betterAuthUserId,
        traceId: input.traceId,
        acceptedAt: this.clock(),
      });
      if (accepted === null) throw unavailableInvitationError();
      return {
        data: {
          accepted: true as const,
          account_id: accepted.accountId,
          webauthn_enrollment_required: true as const,
        },
      };
    } catch (error) {
      await this.repository.releaseClaim({
        invitationId: invitation.invitationId,
        claimId,
      });
      throw error;
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function withToken(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

function unavailableInvitationError(): AppError {
  return new AppError({
    code: "authentication.staff_invitation_unavailable",
    title: "Staff invitation unavailable",
    status: 409,
    detail: "The staff invitation is expired, revoked, accepted, or currently being processed.",
  });
}
