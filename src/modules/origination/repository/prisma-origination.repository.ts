import type { PgBoss } from "pg-boss";
import { ulid } from "ulid";
import { z } from "zod";

import { Prisma } from "../../../generated/prisma/client.js";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { enqueueTransactionalJob } from "../../../shared/jobs/enqueue-job.js";
import { CaseSubmissionConflictError } from "./origination.repository.js";
import type {
  CaseMessageRecord,
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
  PublishedInformationRequest,
  PublishedInformationRequestForTimer,
  RecordedFounderDecision,
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

export class PrismaOriginationRepository implements OriginationRepository {
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
