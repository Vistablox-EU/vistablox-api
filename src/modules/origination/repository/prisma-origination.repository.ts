import type { PgBoss } from "pg-boss";
import { ulid } from "ulid";
import { z } from "zod";

import { Prisma } from "../../../generated/prisma/client.js";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { enqueueTransactionalJob } from "../../../shared/jobs/enqueue-job.js";
import { CaseSubmissionConflictError } from "./origination.repository.js";
import type {
  PostIpoStructuringHandoffRepository,
  TransitionedToPostIpoStructuring,
  TransitionToPostIpoStructuringInput,
} from "./post-ipo-structuring-handoff.repository.js";
import type {
  AssignedPartnerOrganization,
  AssignPartnerOrganizationInput,
  CaseMessageRecord,
  CasePartnerAssignment,
  ClosedCase,
  CloseCaseInput,
  FounderDecisionInput,
  CreateDraftIntakeInput,
  CreatedDraftIntake,
  InformationRequestRecord,
  IntakePrerequisites,
  OperationsCaseDetail,
  OriginationCaseCursor,
  OriginationRepository,
  OwnedOriginationCase,
  PartnerCaseDetail,
  PublishedInformationRequest,
  PublishedInformationRequestForTimer,
  RecordAppraisalInput,
  RecordedFounderDecision,
  RecordLegalStructuringInput,
  ResubmittedCase,
  SubmitInitialCaseInput,
  SubmittedCase,
  ThreadLane,
} from "./origination.repository.js";
import { CaseReviewConflictError } from "./origination.repository.js";

const propertyFloorSettingSchema = z.object({
  amount: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.literal("EUR"),
});

const responseWindowSettingSchema = z.object({ business_days: z.number().int().min(1).max(60) });

const reminderDaysSettingSchema = z.object({
  business_days: z.array(z.number().int().min(1).max(60)).min(1),
});

export class PrismaOriginationRepository
  implements OriginationRepository, PostIpoStructuringHandoffRepository
{
  public constructor(
    private readonly database: DatabaseClient,
    private readonly pgBoss: PgBoss,
  ) {}

  public async getIntakePrerequisites(accountId: string): Promise<IntakePrerequisites> {
    const [eligibility, floorSetting] = await Promise.all([
      this.database.kycEligibility.findUnique({
        where: { accountId },
        select: {
          eligibilityState: true,
          proofOfAddressCurrentUntil: true,
        },
      }),
      this.database.platformSetting.findUnique({
        where: { key: "origination.minimum_property_value_eur" },
        select: { value: true },
      }),
    ]);

    if (floorSetting === null) {
      throw new Error("Missing origination.minimum_property_value_eur platform setting");
    }
    const parsedFloor = propertyFloorSettingSchema.parse(floorSetting.value);

    return {
      eligibilityState: eligibility?.eligibilityState ?? "not_started",
      proofOfAddressCurrentUntil: eligibility?.proofOfAddressCurrentUntil ?? null,
      minimumPropertyValueEur: parsedFloor.amount,
    };
  }

  public async createDraftIntake(
    input: CreateDraftIntakeInput,
  ): Promise<CreatedDraftIntake> {
    const propertyId = `prop_${ulid()}`;
    const caseId = `case_${ulid()}`;

    await this.database.$transaction(async (transaction) => {
      await transaction.property.create({
        data: {
          id: propertyId,
          propertyType: "residential",
          countryCode: input.property.countryCode,
          city: input.property.city,
          addressLine: input.property.addressLine,
          landRegistryReference: input.property.landRegistryReference,
          latitude: input.property.latitude,
          longitude: input.property.longitude,
          ownerDeclaredValueEur: input.property.ownerDeclaredValueEur,
          hasExistingEncumbrance: input.property.hasExistingEncumbrance,
        },
      });
      await transaction.originationCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: input.accountId,
          stage: "draft",
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "origination.case_draft_created",
          resourceType: "origination_case",
          resourceId: caseId,
          changes: {
            trace_id: input.traceId,
            stage: "draft",
            property_id: propertyId,
          },
        },
      });
    });

    return { caseId, propertyId, stage: "draft" };
  }

  public async listOwnedCases(input: {
    accountId: string;
    limit: number;
    after?: OriginationCaseCursor;
  }): Promise<OwnedOriginationCase[]> {
    const cases = await this.database.originationCase.findMany({
      where: {
        applicantAccountId: input.accountId,
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                { createdAt: input.after.createdAt, id: { lt: input.after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: ownedCaseSelect,
    });

    return cases.map(toOwnedCase);
  }

  public async getOwnedCase(
    accountId: string,
    caseId: string,
  ): Promise<OwnedOriginationCase | null> {
    const originationCase = await this.database.originationCase.findFirst({
      where: { id: caseId, applicantAccountId: accountId },
      select: ownedCaseSelect,
    });
    return originationCase === null ? null : toOwnedCase(originationCase);
  }

  public async submitInitialCase(
    input: SubmitInitialCaseInput,
  ): Promise<SubmittedCase | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
          AND applicant_account_id = ${input.accountId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        return null;
      }

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true, currentSubmissionRevisionId: true },
      });
      if (current.stage !== "draft" || current.currentSubmissionRevisionId !== null) {
        throw new CaseSubmissionConflictError(current.stage);
      }

      const revisionId = `rev_${ulid()}`;
      const submittedAt = new Date();
      await transaction.submissionRevision.create({
        data: {
          id: revisionId,
          caseId: input.caseId,
          revisionNumber: 1,
          submittedAt,
          submittedByAccountId: input.accountId,
          submissionData: input.submissionData as Prisma.InputJsonObject,
          reason: "initial",
        },
      });
      await transaction.documentaryScreeningEvidence.createMany({
        data: input.documents.map((document) => ({
          id: `evidence_${ulid()}`,
          caseId: input.caseId,
          submissionRevisionId: revisionId,
          documentType: document.documentType,
          status: "pending",
          documentRef: document.documentRef,
          extractDated: document.extractDated,
        })),
      });
      await transaction.originationCase.update({
        where: { id: input.caseId },
        data: {
          stage: "submitted",
          currentSubmissionRevisionId: revisionId,
          updatedAt: submittedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "origination.case_submitted",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: "draft",
            new_stage: "submitted",
            revision_id: revisionId,
            revision_number: 1,
          },
        },
      });

      return {
        caseId: input.caseId,
        revisionId,
        revisionNumber: 1,
        stage: "submitted",
        submittedAt,
      };
    });
  }

  public async listCasesForOperations(input: {
    limit: number;
    stage?: string;
    after?: OriginationCaseCursor;
  }): Promise<OwnedOriginationCase[]> {
    const cases = await this.database.originationCase.findMany({
      where: {
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                { createdAt: input.after.createdAt, id: { lt: input.after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: ownedCaseSelect,
    });
    return cases.map(toOwnedCase);
  }

  public async getCaseForOperations(caseId: string): Promise<OperationsCaseDetail | null> {
    const originationCase = await this.database.originationCase.findUnique({
      where: { id: caseId },
      select: {
        ...ownedCaseSelect,
        applicantAccountId: true,
        founderReviewNotes: true,
        reviewedByAccountId: true,
        approvedAt: true,
        rejectedAt: true,
        rejectionReasonCode: true,
        rejectionNotes: true,
        ipoPeriodDays: true,
        ipoEndAt: true,
        ipoValueEur: true,
        currentSubmissionRevision: {
          select: {
            id: true,
            revisionNumber: true,
            submittedAt: true,
            submittedByAccountId: true,
            submissionData: true,
            evidence: {
              orderBy: [{ documentType: "asc" }, { id: "asc" }],
              select: {
                id: true,
                documentType: true,
                status: true,
                documentRef: true,
                extractDated: true,
                uploadedAt: true,
              },
            },
          },
        },
        informationRequests: {
          orderBy: [{ proposedAt: "desc" }, { id: "desc" }],
          select: informationRequestSelect,
        },
      },
    });
    if (originationCase === null) return null;

    const owned = toOwnedCase({
      ...originationCase,
      currentSubmissionRevision:
        originationCase.currentSubmissionRevision === null
          ? null
          : {
              revisionNumber: originationCase.currentSubmissionRevision.revisionNumber,
              submittedAt: originationCase.currentSubmissionRevision.submittedAt,
            },
    });
    return {
      ...owned,
      applicantAccountId: originationCase.applicantAccountId,
      founderReviewNotes: originationCase.founderReviewNotes,
      reviewedByAccountId: originationCase.reviewedByAccountId,
      approvedAt: originationCase.approvedAt,
      rejectedAt: originationCase.rejectedAt,
      rejectionReasonCode: originationCase.rejectionReasonCode,
      rejectionNotes: originationCase.rejectionNotes,
      ipoPeriodDays: originationCase.ipoPeriodDays,
      ipoEndAt: originationCase.ipoEndAt,
      ipoValueEur: originationCase.ipoValueEur?.toFixed(2) ?? null,
      submission:
        originationCase.currentSubmissionRevision === null
          ? null
          : {
              revisionId: originationCase.currentSubmissionRevision.id,
              revisionNumber: originationCase.currentSubmissionRevision.revisionNumber,
              submittedAt: originationCase.currentSubmissionRevision.submittedAt,
              submittedByAccountId:
                originationCase.currentSubmissionRevision.submittedByAccountId,
              submissionData: originationCase.currentSubmissionRevision.submissionData,
              evidence: originationCase.currentSubmissionRevision.evidence.map((evidence) => ({
                evidenceId: evidence.id,
                documentType: evidence.documentType,
                status: evidence.status,
                documentRef: evidence.documentRef,
                extractDated: evidence.extractDated,
                uploadedAt: evidence.uploadedAt,
              })),
            },
      informationRequests: originationCase.informationRequests.map(toInformationRequest),
    };
  }

  public async getCasePartnerAssignment(caseId: string): Promise<CasePartnerAssignment | null> {
    const originationCase = await this.database.originationCase.findUnique({
      where: { id: caseId },
      select: { stage: true, legalPracticeId: true, appraisalFirmId: true },
    });
    if (originationCase === null) return null;
    return {
      stage: originationCase.stage,
      legalPracticeId: originationCase.legalPracticeId,
      appraisalFirmId: originationCase.appraisalFirmId,
    };
  }

  public async assignPartnerOrganization(
    input: AssignPartnerOrganizationInput,
  ): Promise<AssignedPartnerOrganization | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true },
      });
      // Mirrors domain/case-review.policy.ts's canAssignPartnerOrganization --
      // this repository layer doesn't import the domain layer, so the
      // condition is duplicated here as this transaction's own recheck,
      // matching every other stage-guarded write in this file.
      if (current.stage !== "post_ipo_structuring" && current.stage !== "approved_for_final_offering") {
        throw new CaseReviewConflictError(
          current.stage,
          "assign a legal practice or appraisal firm",
        );
      }

      const updated = await transaction.originationCase.update({
        where: { id: input.caseId },
        data: {
          ...(input.legalPracticeId === undefined
            ? {}
            : { legalPracticeId: input.legalPracticeId }),
          ...(input.appraisalFirmId === undefined
            ? {}
            : { appraisalFirmId: input.appraisalFirmId }),
          updatedAt: input.assignedAt,
        },
        select: { id: true, legalPracticeId: true, appraisalFirmId: true },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "origination.case_partner_organization_assigned",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            legal_practice_id: updated.legalPracticeId,
            appraisal_firm_id: updated.appraisalFirmId,
          },
          createdAt: input.assignedAt,
        },
      });
      return {
        caseId: updated.id,
        legalPracticeId: updated.legalPracticeId,
        appraisalFirmId: updated.appraisalFirmId,
      };
    });
  }

  public async transitionToPostIpoStructuring(
    input: TransitionToPostIpoStructuringInput,
  ): Promise<TransitionedToPostIpoStructuring> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new Error(
          `Origination case ${input.caseId} not found while transitioning to post_ipo_structuring.`,
        );
      }

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true },
      });
      // A retried or twice-delivered job replaying an already-applied
      // transition must be a safe no-op, the same idempotency
      // openOfferingForApprovedCase's own reverse-direction handoff relies
      // on -- never a thrown error just because the write already landed.
      if (current.stage === "post_ipo_structuring" || current.stage === "approved_for_final_offering") {
        return { caseId: input.caseId, stage: current.stage };
      }
      if (current.stage !== "pre_offering_open") {
        // Not a CaseReviewConflictError: that class models an HTTP staff
        // action losing a race against the case's current stage. This is a
        // worker-only invariant -- publishFinalOfferingTerms only ever
        // enqueues this job for a case that already reached
        // pre_offering_open (the only path to having an offering at all) --
        // so reaching any other stage here means the data is inconsistent,
        // not that the caller should retry.
        throw new Error(
          `Origination case ${input.caseId} is in stage ${current.stage}, not pre_offering_open; cannot transition to post_ipo_structuring.`,
        );
      }

      await transaction.originationCase.update({
        where: { id: input.caseId },
        data: { stage: "post_ipo_structuring", updatedAt: input.transitionedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "origination.case_post_ipo_structuring_started",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: "pre_offering_open",
            new_stage: "post_ipo_structuring",
          },
          createdAt: input.transitionedAt,
        },
      });
      return { caseId: input.caseId, stage: "post_ipo_structuring" };
    });
  }

  public async listCasesForPartner(input: {
    role: "legal_partner" | "appraisal_partner";
    organizationId: string;
    limit: number;
    after?: OriginationCaseCursor;
  }): Promise<PartnerCaseDetail[]> {
    const cases = await this.database.originationCase.findMany({
      where: {
        ...(input.role === "legal_partner"
          ? { legalPracticeId: input.organizationId }
          : { appraisalFirmId: input.organizationId }),
        // Same accessible-stage set require-partner-case-assignment.ts's
        // middleware enforces for a single case -- a partner's list must
        // never surface a case outside what they could otherwise open.
        stage: { in: ["post_ipo_structuring", "approved_for_final_offering"] },
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                { createdAt: input.after.createdAt, id: { lt: input.after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: partnerCaseSelect,
    });
    return cases.map(toPartnerCaseDetail);
  }

  public async getCaseForPartner(caseId: string): Promise<PartnerCaseDetail | null> {
    const originationCase = await this.database.originationCase.findUnique({
      where: { id: caseId },
      select: partnerCaseSelect,
    });
    if (originationCase === null) return null;
    return toPartnerCaseDetail(originationCase);
  }

  public async recordLegalStructuring(
    input: RecordLegalStructuringInput,
  ): Promise<PartnerCaseDetail | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true, legalStructuringCompletedAt: true, appraisalCompletedAt: true },
      });
      // Mirrors domain/case-review.policy.ts's canRecordPartnerWriteback --
      // this repository layer doesn't import the domain layer, so the
      // condition is duplicated here as this transaction's own recheck,
      // matching every other stage-guarded write in this file.
      if (current.stage !== "post_ipo_structuring") {
        throw new CaseReviewConflictError(current.stage, "record legal structuring");
      }

      // A completed_at already set is never refreshed by a later call --
      // it records when the work first finished, not when it was last
      // touched. markCompleted is otherwise a one-way switch: there is no
      // "uncomplete" (see recordAppraisal's mirrored comment).
      const legalStructuringCompletedAt =
        current.legalStructuringCompletedAt ?? (input.markCompleted === true ? input.recordedAt : null);
      // Mirrors domain/case-review.policy.ts's isPostIpoStructuringComplete,
      // duplicated here for the same reason as the recheck above.
      const bothComplete = legalStructuringCompletedAt !== null && current.appraisalCompletedAt !== null;

      const updated = await transaction.originationCase.update({
        where: { id: input.caseId },
        data: {
          ...(input.legalDocumentRefs === undefined ? {} : { legalDocumentRefs: input.legalDocumentRefs }),
          legalStructuringCompletedAt,
          ...(bothComplete
            ? {
                stage: "approved_for_final_offering",
                approvedForFinalOfferingAt: input.recordedAt,
                postIpoStructuringCompletedAt: input.recordedAt,
              }
            : {}),
          updatedAt: input.recordedAt,
        },
        select: partnerCaseSelect,
      });
      const detail = toPartnerCaseDetail(updated);
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "origination.case_legal_structuring_recorded",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            legal_document_refs: detail.legalDocumentRefs,
            legal_structuring_completed_at: detail.legalStructuringCompletedAt?.toISOString() ?? null,
          },
          createdAt: input.recordedAt,
        },
      });
      if (bothComplete) {
        await transaction.auditLog.create({ data: postIpoStructuringCompleteAuditData(input) });
      }
      return detail;
    });
  }

  public async recordAppraisal(input: RecordAppraisalInput): Promise<PartnerCaseDetail | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true, legalStructuringCompletedAt: true, appraisalCompletedAt: true },
      });
      if (current.stage !== "post_ipo_structuring") {
        throw new CaseReviewConflictError(current.stage, "record an appraisal");
      }

      // See recordLegalStructuring's mirrored comment: completed_at, once
      // set, is never refreshed or unset by a later call.
      const appraisalCompletedAt =
        current.appraisalCompletedAt ?? (input.markCompleted === true ? input.recordedAt : null);
      const bothComplete = current.legalStructuringCompletedAt !== null && appraisalCompletedAt !== null;

      const updated = await transaction.originationCase.update({
        where: { id: input.caseId },
        data: {
          ...(input.appraisalValueOpinionEur === undefined
            ? {}
            : { appraisalValueOpinionEur: input.appraisalValueOpinionEur }),
          ...(input.appraisalDocumentRefs === undefined
            ? {}
            : { appraisalDocumentRefs: input.appraisalDocumentRefs }),
          appraisalCompletedAt,
          ...(bothComplete
            ? {
                stage: "approved_for_final_offering",
                approvedForFinalOfferingAt: input.recordedAt,
                postIpoStructuringCompletedAt: input.recordedAt,
              }
            : {}),
          updatedAt: input.recordedAt,
        },
        select: partnerCaseSelect,
      });
      const detail = toPartnerCaseDetail(updated);
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "origination.case_appraisal_recorded",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            appraisal_value_opinion_eur: detail.appraisalValueOpinionEur,
            appraisal_document_refs: detail.appraisalDocumentRefs,
            appraisal_completed_at: detail.appraisalCompletedAt?.toISOString() ?? null,
          },
          createdAt: input.recordedAt,
        },
      });
      if (bothComplete) {
        await transaction.auditLog.create({ data: postIpoStructuringCompleteAuditData(input) });
      }
      return detail;
    });
  }

  public async getApplicantResponseWindowBusinessDays(): Promise<number> {
    const setting = await this.database.platformSetting.findUnique({
      where: { key: "origination.applicant_response_window_business_days" },
      select: { value: true },
    });
    if (setting === null) {
      throw new Error("Missing origination.applicant_response_window_business_days setting");
    }
    return responseWindowSettingSchema.parse(setting.value).business_days;
  }

  public async getInformationRequestReminderBusinessDays(): Promise<number[]> {
    const setting = await this.database.platformSetting.findUnique({
      where: { key: "origination.information_request_reminder_business_days" },
      select: { value: true },
    });
    if (setting === null) {
      throw new Error(
        "Missing origination.information_request_reminder_business_days setting",
      );
    }
    return reminderDaysSettingSchema.parse(setting.value).business_days;
  }

  public async publishInformationRequest(input: {
    accountId: string;
    caseId: string;
    traceId: string;
    requestBody: string;
    publishedAt: Date;
    dueAt: Date;
  }): Promise<PublishedInformationRequest | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          currentSubmissionRevisionId: true,
          informationRequests: {
            where: { status: "published" },
            take: 1,
            select: { id: true },
          },
        },
      });
      if (
        current.stage !== "submitted" ||
        current.currentSubmissionRevisionId === null ||
        current.informationRequests.length > 0
      ) {
        throw new CaseReviewConflictError(current.stage, "publish an information request");
      }

      const request = await transaction.informationRequest.create({
        data: {
          id: `rfi_${ulid()}`,
          caseId: input.caseId,
          requestingWorkstream: "origination",
          proposedByAccountId: input.accountId,
          proposedAt: input.publishedAt,
          status: "published",
          publishedByAccountId: input.accountId,
          publishedAt: input.publishedAt,
          dueAt: input.dueAt,
          requestBody: input.requestBody,
        },
        select: informationRequestSelect,
      });
      await transaction.originationCase.update({
        where: { id: input.caseId },
        data: { stage: "waiting_on_applicant", updatedAt: input.publishedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "origination.information_request_published",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            request_id: request.id,
            previous_stage: "submitted",
            new_stage: "waiting_on_applicant",
            due_at: input.dueAt.toISOString(),
          },
        },
      });
      return {
        ...toInformationRequest(request),
        status: "published",
        publishedAt: input.publishedAt,
        dueAt: input.dueAt,
      };
    });
  }

  public async listPublishedInformationRequestsForTimers(): Promise<
    PublishedInformationRequestForTimer[]
  > {
    const requests = await this.database.informationRequest.findMany({
      where: { status: "published" },
      select: {
        id: true,
        caseId: true,
        publishedAt: true,
        dueAt: true,
        case: {
          select: {
            applicantAccountId: true,
            applicant: { select: { protectedContactEmail: true } },
          },
        },
      },
    });
    return requests
      .filter((request) => request.publishedAt !== null && request.dueAt !== null)
      .map((request) => ({
        requestId: request.id,
        caseId: request.caseId,
        applicantAccountId: request.case.applicantAccountId,
        applicantContactEmail: request.case.applicant.protectedContactEmail,
        publishedAt: request.publishedAt as Date,
        dueAt: request.dueAt as Date,
      }));
  }

  public async expireInformationRequest(input: {
    requestId: string;
    caseId: string;
    traceId: string;
    expiredAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return false;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          informationRequests: {
            where: { id: input.requestId },
            take: 1,
            select: { id: true, status: true },
          },
        },
      });
      const request = current.informationRequests[0];
      if (current.stage !== "waiting_on_applicant" || request?.status !== "published") {
        return false;
      }

      await transaction.informationRequest.update({
        where: { id: input.requestId },
        data: {
          status: "expired",
          resolvedAt: input.expiredAt,
          resolutionType: "expired",
        },
      });
      await transaction.originationCase.update({
        where: { id: input.caseId },
        data: {
          stage: "expired",
          expiredAt: input.expiredAt,
          updatedAt: input.expiredAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "origination.information_request_expired",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            request_id: input.requestId,
            previous_stage: "waiting_on_applicant",
            new_stage: "expired",
          },
          createdAt: input.expiredAt,
        },
      });
      return true;
    });
  }

  public async getOwnedInformationRequest(
    accountId: string,
    caseId: string,
    requestId: string,
  ): Promise<InformationRequestRecord | null> {
    const request = await this.database.informationRequest.findFirst({
      where: {
        id: requestId,
        caseId,
        case: { applicantAccountId: accountId },
      },
      select: informationRequestSelect,
    });
    return request === null ? null : toInformationRequest(request);
  }

  public async listOwnedInformationRequests(
    accountId: string,
    caseId: string,
  ): Promise<InformationRequestRecord[] | null> {
    const ownedCase = await this.database.originationCase.findFirst({
      where: { id: caseId, applicantAccountId: accountId },
      select: {
        informationRequests: {
          where: { publishedAt: { not: null } },
          orderBy: [{ proposedAt: "desc" }, { id: "desc" }],
          select: informationRequestSelect,
        },
      },
    });
    return ownedCase === null
      ? null
      : ownedCase.informationRequests.map(toInformationRequest);
  }

  public async resubmitAfterInformationRequest(
    input: SubmitInitialCaseInput & { requestId: string; submittedAt: Date },
  ): Promise<ResubmittedCase | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
          AND applicant_account_id = ${input.accountId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: {
          stage: true,
          currentSubmissionRevision: { select: { revisionNumber: true } },
          informationRequests: {
            where: { id: input.requestId },
            take: 1,
            select: { id: true, status: true },
          },
        },
      });
      const request = current.informationRequests[0];
      if (
        current.stage !== "waiting_on_applicant" ||
        current.currentSubmissionRevision === null ||
        request?.status !== "published"
      ) {
        throw new CaseReviewConflictError(current.stage, "resubmit this case");
      }

      const revisionNumber = current.currentSubmissionRevision.revisionNumber + 1;
      const revisionId = `rev_${ulid()}`;
      await transaction.submissionRevision.create({
        data: {
          id: revisionId,
          caseId: input.caseId,
          revisionNumber,
          submittedAt: input.submittedAt,
          submittedByAccountId: input.accountId,
          submissionData: input.submissionData as Prisma.InputJsonObject,
          reason: "resubmission_after_rfi",
        },
      });
      await transaction.documentaryScreeningEvidence.createMany({
        data: input.documents.map((document) => ({
          id: `evidence_${ulid()}`,
          caseId: input.caseId,
          submissionRevisionId: revisionId,
          documentType: document.documentType,
          status: "pending",
          documentRef: document.documentRef,
          extractDated: document.extractDated,
        })),
      });
      await transaction.informationRequest.update({
        where: { id: input.requestId },
        data: {
          status: "answered",
          resolvedAt: input.submittedAt,
          resolutionType: "resubmitted",
          resolvingRevisionId: revisionId,
        },
      });
      await transaction.originationCase.update({
        where: { id: input.caseId },
        data: {
          stage: "submitted",
          currentSubmissionRevisionId: revisionId,
          updatedAt: input.submittedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "origination.case_resubmitted",
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            request_id: input.requestId,
            previous_stage: "waiting_on_applicant",
            new_stage: "submitted",
            revision_id: revisionId,
            revision_number: revisionNumber,
          },
        },
      });
      return {
        caseId: input.caseId,
        revisionId,
        revisionNumber,
        stage: "submitted",
        submittedAt: input.submittedAt,
      };
    });
  }

  public async recordFounderDecision(
    input: FounderDecisionInput,
  ): Promise<RecordedFounderDecision | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true, currentSubmissionRevisionId: true, propertyId: true },
      });
      if (current.stage !== "submitted" || current.currentSubmissionRevisionId === null) {
        throw new CaseReviewConflictError(current.stage, "record a founder decision");
      }

      const stage = input.decision === "approve" ? "pre_offering_open" : "rejected";
      await transaction.originationCase.update({
        where: { id: input.caseId },
        data:
          input.decision === "approve"
            ? {
                stage,
                founderReviewNotes: input.founderReviewNotes,
                reviewedByAccountId: input.accountId,
                approvedAt: input.decidedAt,
                ipoPeriodDays: input.ipoPeriodDays,
                ipoEndAt: input.ipoEndAt,
                ipoValueEur: input.ipoValueEur,
                exclusivityCommencedAt: input.decidedAt,
                updatedAt: input.decidedAt,
              }
            : {
                stage,
                canReopen: false,
                founderReviewNotes: input.founderReviewNotes,
                reviewedByAccountId: input.accountId,
                rejectedAt: input.decidedAt,
                rejectionReasonCode: input.rejectionReasonCode,
                rejectionNotes: input.rejectionNotes,
                updatedAt: input.decidedAt,
              },
      });
      if (input.decision === "approve") {
        // AD-145: origination approval never writes into the offering
        // domain's tables directly — it durably hands off, in this same
        // transaction, to the job that opens the Piv/Offering shell the
        // now-`pre_offering_open` property needs to be browsable and
        // reservation-ready.
        await enqueueTransactionalJob(
          this.pgBoss,
          transaction,
          "case_timers.pre_offering_open_handoff",
          {
            case_id: input.caseId,
            property_id: current.propertyId,
            ipo_value_eur: input.ipoValueEur,
          },
          input.traceId,
        );
      }
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: `origination.case_${input.decision === "approve" ? "approved" : "rejected"}`,
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: "submitted",
            new_stage: stage,
            reviewed_revision_id: current.currentSubmissionRevisionId,
            ...(input.decision === "approve"
              ? {
                  ipo_period_days: input.ipoPeriodDays,
                  ipo_end_at: input.ipoEndAt.toISOString(),
                  ipo_value_eur: input.ipoValueEur,
                }
              : { rejection_reason_code: input.rejectionReasonCode }),
          },
        },
      });
      return {
        caseId: input.caseId,
        stage,
        decidedAt: input.decidedAt,
        ipoEndAt: input.decision === "approve" ? input.ipoEndAt : null,
      };
    });
  }

  // REAL_ESTATE_INTAKE_LIFECYCLE.md's state diagram, distinct from
  // recordFounderDecision above (the submitted-stage initial review):
  // withdrawn is reachable from draft/submitted/waiting_on_applicant/
  // pre_offering_open; the only other manual closure the diagram shows is
  // pre_offering_open -> rejected ("ipo_period ends underfunded, founder
  // closes the case"). expired has no manual path — see
  // expireInformationRequest above.
  public async closeCase(input: CloseCaseInput): Promise<ClosedCase | null> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ case_id: string }>>`
        SELECT case_id
        FROM origination.origination_cases
        WHERE case_id = ${input.caseId}
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const current = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { stage: true },
      });
      const closableFrom: Record<CloseCaseInput["outcome"], readonly string[]> = {
        withdrawn: ["draft", "submitted", "waiting_on_applicant", "pre_offering_open"],
        rejected: ["pre_offering_open"],
      };
      if (!closableFrom[input.outcome].includes(current.stage)) {
        throw new CaseReviewConflictError(current.stage, "close the case");
      }

      await transaction.originationCase.update({
        where: { id: input.caseId },
        data: {
          stage: input.outcome,
          canReopen: false,
          founderReviewNotes: input.founderReviewNotes,
          reviewedByAccountId: input.accountId,
          updatedAt: input.closedAt,
          ...(input.outcome === "withdrawn"
            ? { withdrawnAt: input.closedAt }
            : {
                rejectedAt: input.closedAt,
                rejectionReasonCode: input.rejectionReasonCode,
                rejectionNotes: input.rejectionNotes,
              }),
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: `origination.case_${input.outcome}`,
          resourceType: "origination_case",
          resourceId: input.caseId,
          changes: {
            trace_id: input.traceId,
            previous_stage: current.stage,
            new_stage: input.outcome,
            ...(input.outcome === "rejected"
              ? { rejection_reason_code: input.rejectionReasonCode }
              : {}),
          },
          createdAt: input.closedAt,
        },
      });
      return { caseId: input.caseId, stage: input.outcome, closedAt: input.closedAt };
    });
  }

  public async listCaseMessages(caseId: string, lane: ThreadLane): Promise<CaseMessageRecord[]> {
    const thread = await this.database.caseThread.findUnique({
      where: { caseId_lane: { caseId, lane } },
      select: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: { id: true, authorAccountId: true, body: true, createdAt: true },
        },
      },
    });
    return (thread?.messages ?? []).map(toCaseMessageRecord);
  }

  public async postCaseMessage(input: {
    caseId: string;
    lane: ThreadLane;
    authorAccountId: string;
    body: string;
    postedAt: Date;
  }): Promise<CaseMessageRecord | null> {
    return this.database.$transaction(async (transaction) => {
      const exists = await transaction.originationCase.findUnique({
        where: { id: input.caseId },
        select: { id: true },
      });
      if (exists === null) return null;

      const thread = await transaction.caseThread.upsert({
        where: { caseId_lane: { caseId: input.caseId, lane: input.lane } },
        create: { id: `thread_${ulid()}`, caseId: input.caseId, lane: input.lane },
        update: {},
      });
      const message = await transaction.caseMessage.create({
        data: {
          id: `msg_${ulid()}`,
          threadId: thread.id,
          authorAccountId: input.authorAccountId,
          body: input.body,
          createdAt: input.postedAt,
        },
        select: { id: true, authorAccountId: true, body: true, createdAt: true },
      });
      return toCaseMessageRecord(message);
    });
  }
}

function toCaseMessageRecord(input: {
  id: string;
  authorAccountId: string | null;
  body: string;
  createdAt: Date;
}): CaseMessageRecord {
  return {
    messageId: input.id,
    authorAccountId: input.authorAccountId,
    body: input.body,
    createdAt: input.createdAt,
  };
}

const ownedCaseSelect = {
  id: true,
  stage: true,
  createdAt: true,
  updatedAt: true,
  currentSubmissionRevision: {
    select: { revisionNumber: true, submittedAt: true },
  },
  property: {
    select: {
      id: true,
      propertyType: true,
      countryCode: true,
      city: true,
      addressLine: true,
      landRegistryReference: true,
      ownerDeclaredValueEur: true,
      hasExistingEncumbrance: true,
    },
  },
} as const;

const informationRequestSelect = {
  id: true,
  caseId: true,
  status: true,
  requestBody: true,
  publishedAt: true,
  dueAt: true,
  resolvedAt: true,
  resolutionType: true,
  resolvingRevisionId: true,
} as const;

function toInformationRequest(input: {
  id: string;
  caseId: string;
  status: string;
  requestBody: string;
  publishedAt: Date | null;
  dueAt: Date | null;
  resolvedAt: Date | null;
  resolutionType: string | null;
  resolvingRevisionId: string | null;
}): InformationRequestRecord {
  return {
    requestId: input.id,
    caseId: input.caseId,
    status: input.status,
    requestBody: input.requestBody,
    publishedAt: input.publishedAt,
    dueAt: input.dueAt,
    resolvedAt: input.resolvedAt,
    resolutionType: input.resolutionType,
    resolvingRevisionId: input.resolvingRevisionId,
  };
}

function toOwnedCase(input: {
  id: string;
  stage: string;
  createdAt: Date;
  updatedAt: Date;
  currentSubmissionRevision: { revisionNumber: number; submittedAt: Date } | null;
  property: {
    id: string;
    propertyType: string;
    countryCode: string;
    city: string | null;
    addressLine: string | null;
    landRegistryReference: string | null;
    ownerDeclaredValueEur: { toFixed(fractionDigits: number): string };
    hasExistingEncumbrance: boolean;
  };
}): OwnedOriginationCase {
  return {
    caseId: input.id,
    stage: input.stage,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    currentRevision: input.currentSubmissionRevision,
    property: {
      propertyId: input.property.id,
      propertyType: input.property.propertyType,
      countryCode: input.property.countryCode,
      city: input.property.city,
      addressLine: input.property.addressLine,
      landRegistryReference: input.property.landRegistryReference,
      ownerDeclaredValueEur: input.property.ownerDeclaredValueEur.toFixed(2),
      hasExistingEncumbrance: input.property.hasExistingEncumbrance,
    },
  };
}

const partnerCaseSelect = {
  ...ownedCaseSelect,
  legalDocumentRefs: true,
  legalStructuringCompletedAt: true,
  appraisalValueOpinionEur: true,
  appraisalDocumentRefs: true,
  appraisalCompletedAt: true,
  postIpoStructuringCompletedAt: true,
} as const;

function toPartnerCaseDetail(
  input: Parameters<typeof toOwnedCase>[0] & {
    legalDocumentRefs: string[];
    legalStructuringCompletedAt: Date | null;
    appraisalValueOpinionEur: { toFixed(fractionDigits: number): string } | null;
    appraisalDocumentRefs: string[];
    appraisalCompletedAt: Date | null;
    postIpoStructuringCompletedAt: Date | null;
  },
): PartnerCaseDetail {
  return {
    ...toOwnedCase(input),
    legalDocumentRefs: input.legalDocumentRefs,
    legalStructuringCompletedAt: input.legalStructuringCompletedAt,
    appraisalValueOpinionEur: input.appraisalValueOpinionEur?.toFixed(2) ?? null,
    appraisalDocumentRefs: input.appraisalDocumentRefs,
    appraisalCompletedAt: input.appraisalCompletedAt,
    postIpoStructuringCompletedAt: input.postIpoStructuringCompletedAt,
  };
}

// The second, separately-named audit entry for the system-computed
// consequence (CORE_TABLES.md's post_ipo_structuring_completed_at comment)
// of whichever partner's writeback happens to complete the pair -- kept
// distinct from that writeback's own entry above so the case's lifecycle
// transition is independently discoverable in the audit log, regardless of
// which partner triggered it.
function postIpoStructuringCompleteAuditData(input: {
  caseId: string;
  traceId: string;
  recordedAt: Date;
}) {
  return {
    id: `audit_${ulid()}`,
    actorAccountId: null,
    action: "origination.case_approved_for_final_offering",
    resourceType: "origination_case",
    resourceId: input.caseId,
    changes: {
      trace_id: input.traceId,
      previous_stage: "post_ipo_structuring",
      new_stage: "approved_for_final_offering",
    },
    createdAt: input.recordedAt,
  };
}
