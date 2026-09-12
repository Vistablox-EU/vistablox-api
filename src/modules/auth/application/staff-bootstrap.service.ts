import type {
  StaffBootstrapCounts,
  StaffBootstrapRepository,
} from "../repository/staff-bootstrap.repository.js";
import type { StaffIdentityProvider } from "./staff-identity-provider.js";
import {
  generateInvitationToken,
  STAFF_INVITATION_LIFETIME_MS,
  withToken,
} from "./staff-invitation.service.js";

export type BootstrapFirstAdminResult =
  | { outcome: "refused_admin_exists" }
  | {
      outcome: "issued";
      invitationId: string;
      email: string;
      expiresAt: Date;
      /**
       * The accept link WITH its token. The caller prints it exactly once;
       * it is never stored (only the SHA-256 hash is), logged, or audited.
       */
      invitationUrl: string;
      replacedPendingBootstrapInvitations: number;
      revokedInvitations: number;
      emailDelivery: { delivered: true } | { delivered: false; errorCode: string };
    };

/**
 * One-time bootstrap of the first admin_operations staff member, for the
 * CLI only (src/cli/bootstrap-first-admin.ts) -- there is deliberately no
 * HTTP route. It issues an ordinary staff invitation (same token, hash,
 * 72-hour expiry and accept URL as IssueStaffInvitationService), which is
 * then accepted through the unchanged AcceptStaffInvitationService.
 */
export class BootstrapFirstAdminService {
  public constructor(
    private readonly repository: StaffBootstrapRepository,
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

  /** Read-only: counts, no personal data, no writes. */
  public async check(): Promise<StaffBootstrapCounts> {
    return this.repository.countBootstrapState(this.clock());
  }

  public async issue(input: {
    email: string;
    displayName: string;
    traceId: string;
  }): Promise<BootstrapFirstAdminResult> {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();

    // Early, unlocked refusal so an existing admin gets the precise message
    // and nothing -- not even the Better Auth lookup -- runs. The locked
    // check inside the repository transaction is the one that counts.
    const before = await this.repository.countBootstrapState(this.clock());
    if (before.activeAdminOperationsHolders > 0) return { outcome: "refused_admin_exists" };

    // Same rule as a normal invitation: the email must not already belong
    // to any Better Auth identity (customer or staff).
    await this.identities.assertEmailAvailable(email);

    const { rawToken, tokenHash } = generateInvitationToken();
    const createdAt = this.clock();
    const issued = await this.repository.issueBootstrapInvitation({
      email,
      displayName,
      tokenHash,
      traceId: input.traceId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + STAFF_INVITATION_LIFETIME_MS),
    });
    if (issued.outcome === "admin_exists") return { outcome: "refused_admin_exists" };

    const invitationUrl = withToken(this.invitationAcceptUrl, rawToken);
    // Best effort: the operator gets the link on stdout regardless, so a
    // mail failure neither revokes the invitation (unlike the HTTP path)
    // nor fails the run.
    let emailDelivery: { delivered: true } | { delivered: false; errorCode: string };
    try {
      await this.sendInvitationEmail({
        to: email,
        displayName,
        invitationUrl,
        expiresAt: issued.expiresAt,
      });
      emailDelivery = { delivered: true };
    } catch (error) {
      emailDelivery = { delivered: false, errorCode: describeErrorCode(error) };
    }

    return {
      outcome: "issued",
      invitationId: issued.invitationId,
      email,
      expiresAt: issued.expiresAt,
      invitationUrl,
      replacedPendingBootstrapInvitations: issued.replacedPendingBootstrapInvitations,
      revokedInvitations: issued.revokedInvitations,
      emailDelivery,
    };
  }
}

// Only a code/name, never the error message: a mail transport error could
// in principle echo part of the message it failed to send, and that message
// contains the token.
function describeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "unknown_error";
}
