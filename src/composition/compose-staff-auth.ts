import { createStaffWebAuthnRouter } from "../modules/auth/api/staff/staff-webauthn.router.js";
import { createPublicStaffInvitationRouter } from "../modules/auth/api/staff/staff-invitation-accept.router.js";
import { createInternalStaffInvitationRouter } from "../modules/auth/api/staff/staff-invitation-issue.router.js";
import { createStaffAccountLifecycleRouter } from "../modules/auth/api/staff/staff-account-lifecycle.router.js";
import { AcceptStaffInvitationService, IssueStaffInvitationService } from "../modules/auth/application/staff/staff-invitation.service.js";
import { GrantStaffRoleService, ListStaffAccountsService, OffboardStaffAccountService, RecoverStaffAccountService, RevokeStaffRoleService } from "../modules/auth/application/staff/staff-account-lifecycle.service.js";
import { createAccountRecoveryRouter } from "../modules/auth/api/staff/account-recovery.router.js";
import { CompleteAccountRecoveryService, CreateRecoveryDiditSessionService, DecideAccountRecoveryCaseService, GetAccountRecoveryCaseService, OpenAccountRecoveryCaseService, RecordPrimaryRecoveryReviewService } from "../modules/auth/application/staff/account-recovery.service.js";
import { createAccountClosureRouter } from "../modules/auth/api/customer/account-closure.router.js";
import { createAccountClosureOperationsRouter } from "../modules/auth/api/staff/account-closure-operations.router.js";
import { CancelAccountClosureService, DecideAccountClosureRequestService, ListPendingAccountClosureRequestsService, RequestAccountClosureService } from "../modules/auth/application/shared/account-closure.service.js";
import { StaffWebAuthnService } from "../modules/auth/application/staff/staff-webauthn.service.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

export function composeStaffAuth(context: ProtectedApiContext): void {
  const { app, dependencies, requireAuthentication, requireAdminOperations, requireStaffIdentity, requireStaffWebAuthn, tightenedRateLimiter } = context;
  const staffWebAuthnService = new StaffWebAuthnService(
    dependencies.protectedApi.staffWebAuthnRepository,
    dependencies.protectedApi.staffWebAuthnCeremony,
  );
  if (dependencies.protectedApi.staffInvitations !== undefined) {
    const invitations = dependencies.protectedApi.staffInvitations;
    const issueInvitation = new IssueStaffInvitationService(
      invitations.repository,
      invitations.identities,
      invitations.sendEmail,
      invitations.acceptUrl,
    );
    const acceptInvitation = new AcceptStaffInvitationService(
      invitations.repository,
      invitations.identities,
    );
    app.use(
      "/v1/auth/staff-invitations",
      ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
      createPublicStaffInvitationRouter(acceptInvitation),
    );
    app.use(
      "/internal/v1/auth/staff-invitations",
      createInternalStaffInvitationRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        issueInvitation,
      ),
    );
  }
  if (dependencies.protectedApi.staffAccountLifecycle !== undefined) {
    const lifecycle = dependencies.protectedApi.staffAccountLifecycle;
    app.use(
      "/internal/v1/auth/staff-accounts",
      createStaffAccountLifecycleRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new RecoverStaffAccountService(
          lifecycle.repository,
          lifecycle.administrator,
          lifecycle.recoveryRedirectUrl,
        ),
        new OffboardStaffAccountService(
          lifecycle.repository,
          lifecycle.administrator,
        ),
        new ListStaffAccountsService(lifecycle.repository),
        new GrantStaffRoleService(lifecycle.repository),
        new RevokeStaffRoleService(lifecycle.repository),
      ),
    );
  }
  if (dependencies.protectedApi.accountRecovery !== undefined) {
    const recovery = dependencies.protectedApi.accountRecovery;
    app.use(
      "/internal/v1/account-recovery-cases",
      createAccountRecoveryRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new OpenAccountRecoveryCaseService(
          recovery.repository,
          recovery.administrator,
          recovery.emailSender,
        ),
        new CreateRecoveryDiditSessionService(recovery.repository, recovery.didit, {
          workflowId: recovery.workflowId,
          callbackUrl: recovery.callbackUrl,
        }),
        new GetAccountRecoveryCaseService(recovery.repository, recovery.didit),
        new RecordPrimaryRecoveryReviewService(
          recovery.repository,
          () => new Date(),
          recovery.skipDiditInStaging,
        ),
        new DecideAccountRecoveryCaseService(
          recovery.repository,
          recovery.emailSender,
          () => new Date(),
          recovery.singleReviewerMode,
        ),
        new CompleteAccountRecoveryService(
          recovery.repository,
          recovery.administrator,
          recovery.emailSender,
          recovery.recoveryRedirectUrl,
        ),
      ),
    );
  }
  if (dependencies.protectedApi.accountClosure !== undefined) {
    const closure = dependencies.protectedApi.accountClosure;
    app.use(
      "/v1/auth/account-closure",
      createAccountClosureRouter(
        requireAuthentication,
        new RequestAccountClosureService(closure.repository),
        new CancelAccountClosureService(closure.repository),
      ),
    );
    app.use(
      "/internal/v1/account-closure-requests",
      createAccountClosureOperationsRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new ListPendingAccountClosureRequestsService(closure.repository),
        new DecideAccountClosureRequestService(closure.repository, closure.administrator),
      ),
    );
  }
  app.use(
    "/internal/v1/auth/webauthn",
    ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
    createStaffWebAuthnRouter(
      requireAuthentication,
      requireStaffIdentity,
      staffWebAuthnService,
    ),
  );
}
