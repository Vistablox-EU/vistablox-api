import { createIntakeRouter } from "../modules/intake/api/intake.router.js";
import { createIntakeOperationsRouter } from "../modules/intake/api/intake-operations.router.js";
import { createAppraisalFirmRouter, createLegalPracticeRouter } from "../modules/intake/api/partner-organization.router.js";
import { createAppraisalPartnerCaseRouter, createLegalPartnerCaseRouter } from "../modules/intake/api/partner-case.router.js";
import { createRequirePartnerCaseAssignment } from "../modules/intake/api/require-partner-case-assignment.js";
import { CreateAppraisalFirmService, CreateLegalPracticeService, ListAppraisalFirmsService, ListLegalPracticesService, UpdateAppraisalFirmStatusService, UpdateLegalPracticeStatusService } from "../modules/intake/application/partner-organization.service.js";
import { CreateDraftIntakeService } from "../modules/intake/application/create-draft-intake.service.js";
import { GetOwnCaseService, ListOwnCasesService } from "../modules/intake/application/read-own-cases.service.js";
import { SubmitInitialCaseService } from "../modules/intake/application/submit-initial-case.service.js";
import { AssignPartnerOrganizationService, CloseCaseService, CreateStaffIntakeCaseService, CreateStaffDraftCaseService, SubmitStaffDraftCaseService, ForceExpireInformationRequestService, GetCaseForOperationsService, ListCasesForOperationsService, PublishInformationRequestService, RecordFounderDecisionService, RetryPostIpoStructuringHandoffService, ReviewEvidenceService, SendManualReminderService, WithdrawInformationRequestService } from "../modules/intake/application/operations-case.service.js";
import { GetOperationsReadinessService, type OperationsReadinessRepository } from "../modules/intake/application/get-operations-readiness.service.js";
import { GetIntakeCaseHistoryService, GetIntakeWorkflowService } from "../modules/intake/application/get-intake-workflow.service.js";
import { ApproveIntakeReversalService, CancelIntakeReversalService, GetIntakeReversalOperationService, GetIntakeReversalPreviewService, RequestIntakeReversalService, type ReversalRepository } from "../modules/intake/application/intake-reversal.service.js";
import { TransitionCaseToPostIpoStructuringService } from "../modules/intake/application/post-ipo-structuring-handoff.service.js";
import { GetCaseForPartnerService, GetPartnerCaseHistoryService, ListCasesForPartnerService, RecordAppraisalService, RecordLegalStructuringService } from "../modules/intake/application/partner-case.service.js";
import { ListOwnInformationRequestsService, RespondToInformationRequestService } from "../modules/intake/application/respond-to-information-request.service.js";
import { ListCaseMessagesForOperationsService, ListOwnCaseMessagesService, PostCaseMessageForOperationsService, PostOwnCaseMessageService } from "../modules/intake/application/case-message.service.js";
import type { IntakeRepository } from "../modules/intake/repository/intake.repository.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

export function composeIntake(context: ProtectedApiContext): void {
  const { app, dependencies, requireAuthentication, requireAdminOperations, requireLegalPartner, requireAppraisalPartner, requireStaffWebAuthn } = context;
  const intakeRepository = dependencies.protectedApi.intakeRepository;
  const requireLegalPartnerCaseAssignment = createRequirePartnerCaseAssignment(
    "legal_partner",
    dependencies.protectedApi.accounts,
    intakeRepository,
  );
  const requireAppraisalPartnerCaseAssignment = createRequirePartnerCaseAssignment(
    "appraisal_partner",
    dependencies.protectedApi.accounts,
    intakeRepository,
  );
  app.use(
    "/v1/intake-cases",
    createIntakeRouter(
      requireAuthentication,
      new CreateDraftIntakeService(intakeRepository),
      new ListOwnCasesService(intakeRepository),
      new GetOwnCaseService(intakeRepository),
      new SubmitInitialCaseService(intakeRepository),
      new ListOwnInformationRequestsService(intakeRepository),
      new RespondToInformationRequestService(intakeRepository),
      new ListOwnCaseMessagesService(intakeRepository),
      new PostOwnCaseMessageService(intakeRepository),
    ),
  );
  const partnerOrganizationRepository = dependencies.protectedApi.partnerOrganizations?.repository;
  const operationsReadiness = new GetOperationsReadinessService(
    intakeRepository as unknown as OperationsReadinessRepository,
  );
  app.use(
    "/internal/v1/intake-cases",
    createIntakeOperationsRouter(
      requireAuthentication,
      requireAdminOperations,
      requireStaffWebAuthn,
      new ListCasesForOperationsService(intakeRepository),
      new GetCaseForOperationsService(intakeRepository, dependencies.protectedApi.kyc?.getDisplayProfile),
      new PublishInformationRequestService(intakeRepository),
      new RecordFounderDecisionService(intakeRepository),
      new CloseCaseService(intakeRepository),
      new ListCaseMessagesForOperationsService(intakeRepository),
      new PostCaseMessageForOperationsService(intakeRepository),
      new CreateStaffIntakeCaseService(intakeRepository),
      new RetryPostIpoStructuringHandoffService(
        intakeRepository,
        new TransitionCaseToPostIpoStructuringService(intakeRepository),
      ),
      new ReviewEvidenceService(intakeRepository),
      new ForceExpireInformationRequestService(intakeRepository),
      new SendManualReminderService(intakeRepository, dependencies.protectedApi.emailSender),
      new WithdrawInformationRequestService(intakeRepository),
      operationsReadiness,
      dependencies.protectedApi.documentUpload,
      dependencies.protectedApi.documentDownload,
      partnerOrganizationRepository === undefined
        ? undefined
        : new AssignPartnerOrganizationService(intakeRepository, partnerOrganizationRepository),
      new CreateStaffDraftCaseService(intakeRepository),
      new SubmitStaffDraftCaseService(intakeRepository),
      new GetIntakeWorkflowService(
        intakeRepository as Required<Pick<typeof intakeRepository, "getIntakeWorkflowSnapshot" | "listIntakeCaseHistory">>,
        operationsReadiness,
      ),
      new GetIntakeCaseHistoryService(intakeRepository as Required<Pick<typeof intakeRepository, "getIntakeWorkflowSnapshot" | "listIntakeCaseHistory">>),
      new GetIntakeReversalPreviewService(intakeRepository as ReversalRepository),
      new RequestIntakeReversalService(intakeRepository as ReversalRepository),
      new ApproveIntakeReversalService(intakeRepository as ReversalRepository),
      new GetIntakeReversalOperationService(intakeRepository as ReversalRepository),
      new CancelIntakeReversalService(intakeRepository as ReversalRepository),
    ),
  );
  if (partnerOrganizationRepository !== undefined) {
    app.use(
      "/internal/v1/legal-practices",
      createLegalPracticeRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new CreateLegalPracticeService(partnerOrganizationRepository),
        new ListLegalPracticesService(partnerOrganizationRepository),
        new UpdateLegalPracticeStatusService(partnerOrganizationRepository),
      ),
    );
    app.use(
      "/internal/v1/appraisal-firms",
      createAppraisalFirmRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new CreateAppraisalFirmService(partnerOrganizationRepository),
        new ListAppraisalFirmsService(partnerOrganizationRepository),
        new UpdateAppraisalFirmStatusService(partnerOrganizationRepository),
      ),
    );
  }
  // Unconditional, unlike the admin CRUD/assignment surface above: these
  // only need the always-present accounts/intakeRepository, not the
  // optional partnerOrganizations.repository (legal-practice/appraisal-firm
  // existence isn't looked up here -- createRequirePartnerCaseAssignment
  // already resolved the caller's own organization by the time a handler
  // runs).
  const getCaseForPartner = new GetCaseForPartnerService(intakeRepository);
  app.use(
    "/internal/v1/legal-partner/cases",
    createLegalPartnerCaseRouter(
      requireAuthentication,
      requireLegalPartner,
      requireStaffWebAuthn,
      requireLegalPartnerCaseAssignment,
      new ListCasesForPartnerService(
        "legal_partner",
        dependencies.protectedApi.accounts,
        intakeRepository,
      ),
      getCaseForPartner,
      new RecordLegalStructuringService(intakeRepository),
      new GetPartnerCaseHistoryService(intakeRepository as Required<Pick<IntakeRepository, "listIntakeCaseHistory">>, "legal_partner"),
    ),
  );
  app.use(
    "/internal/v1/appraisal-partner/cases",
    createAppraisalPartnerCaseRouter(
      requireAuthentication,
      requireAppraisalPartner,
      requireStaffWebAuthn,
      requireAppraisalPartnerCaseAssignment,
      new ListCasesForPartnerService(
        "appraisal_partner",
        dependencies.protectedApi.accounts,
        intakeRepository,
      ),
      getCaseForPartner,
      new RecordAppraisalService(intakeRepository),
      new GetPartnerCaseHistoryService(intakeRepository as Required<Pick<IntakeRepository, "listIntakeCaseHistory">>, "appraisal_partner"),
    ),
  );
}
