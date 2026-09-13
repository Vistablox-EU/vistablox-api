import { AppError } from "../../../shared/errors/app-error.js";
import type {
  AssignPartnerOrganizationBody,
  CloseCaseBody,
  CreateStaffCaseBody,
  FounderDecisionBody,
  OperationsCaseListQuery,
  PublishInformationRequestBody,
  ReviewEvidenceBody,
  WithdrawInformationRequestBody,
} from "../api/origination-operations.schemas.js";
import { originationCaseStageSchema } from "../api/origination.schemas.js";
import {
  addBusinessDays,
  canAssignPartnerOrganization,
  canCloseCase,
  canRecordFounderDecision,
  canWithdrawInformationRequest,
  evaluateInformationRequestPublication,
} from "../domain/case-review.policy.js";
import { evaluateInitialCaseSubmission } from "../domain/case-submission.policy.js";
import type { PartnerOrganizationRepository } from "../repository/partner-organization.repository.js";
import {
  ApplicantAccountNotFoundError,
  CaseReviewConflictError,
  EvidenceCaseMismatchError,
  EvidenceNotFoundError,
  type InformationRequestRecord,
  type OperationsCaseDetail,
  type OriginationRepository,
} from "../repository/origination.repository.js";
import {
  decodeCaseCursor,
  encodeCaseCursor,
  toOwnedCaseResponse,
} from "./read-own-cases.service.js";

export class ListCasesForOperationsService {
  public constructor(private readonly repository: OriginationRepository) {}

  public async execute(input: { query: OperationsCaseListQuery }) {
    const after = input.query.after === undefined
      ? undefined
      : decodeCaseCursor(input.query.after);
    const rows = await this.repository.listCasesForOperations({
      limit: input.query.limit + 1,
      ...(input.query.stage === undefined ? {} : { stage: input.query.stage }),
      ...(after === undefined ? {} : { after }),
    });
    const hasNextPage = rows.length > input.query.limit;
    const pageRows = hasNextPage ? rows.slice(0, input.query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(toOwnedCaseResponse),
      page: {
        next_cursor:
          hasNextPage && last !== undefined
            ? encodeCaseCursor({ createdAt: last.createdAt, id: last.caseId })
            : null,
      },
    };
  }
}

export class GetCaseForOperationsService {
  public constructor(private readonly repository: OriginationRepository) {}

  public async execute(caseId: string) {
    const originationCase = await this.repository.getCaseForOperations(caseId);
    if (originationCase === null) throw caseNotFoundError();
    return toOperationsResponse(originationCase);
  }
}

export class PublishInformationRequestService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    traceId: string;
    body: PublishInformationRequestBody;
  }) {
    const [originationCase, responseWindowDays] = await Promise.all([
      this.repository.getCaseForOperations(input.caseId),
      this.repository.getApplicantResponseWindowBusinessDays(),
    ]);
    if (originationCase === null) throw caseNotFoundError();

    const decision = evaluateInformationRequestPublication({
      stage: originationCase.stage,
      hasCurrentRevision: originationCase.currentRevision !== null,
      hasActiveRequest: originationCase.informationRequests.some(
        (request) => request.status === "published",
      ),
    });
    if (!decision.allowed) throw reviewConflictError("publish an information request");

    const publishedAt = this.clock();
    const dueAt = addBusinessDays(publishedAt, responseWindowDays);
    try {
      const request = await this.repository.publishInformationRequest({
        accountId: input.accountId,
        caseId: input.caseId,
        traceId: input.traceId,
        requestBody: input.body.request_body,
        publishedAt,
        dueAt,
      });
      if (request === null) throw caseNotFoundError();
      return {
        data: {
          request_id: request.requestId,
          case_id: request.caseId,
          status: "published" as const,
          request_body: request.requestBody,
          published_at: request.publishedAt.toISOString(),
          due_at: request.dueAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) {
        throw reviewConflictError("publish an information request", error);
      }
      throw error;
    }
  }
}

// A targeted walk-back for a single mistakenly-published information
// request, distinct from CloseCaseService below: this reverts only the one
// request and puts the case back to reviewing the same submission revision
// it was already on, instead of terminating the whole case.
export class WithdrawInformationRequestService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    requestId: string;
    traceId: string;
    body: WithdrawInformationRequestBody;
  }) {
    const originationCase = await this.repository.getCaseForOperations(input.caseId);
    if (originationCase === null) throw caseNotFoundError();

    const request = originationCase.informationRequests.find(
      (candidate) => candidate.requestId === input.requestId,
    );
    if (request === undefined) throw caseNotFoundError();

    if (
      !canWithdrawInformationRequest({
        caseStage: originationCase.stage,
        requestStatus: request.status,
      })
    ) {
      throw reviewConflictError("withdraw this information request");
    }

    const withdrawnAt = this.clock();
    try {
      const withdrawn = await this.repository.withdrawInformationRequest({
        accountId: input.accountId,
        caseId: input.caseId,
        requestId: input.requestId,
        traceId: input.traceId,
        founderReviewNotes: input.body.founder_review_notes,
        withdrawnAt,
      });
      if (withdrawn === null) throw caseNotFoundError();
      return {
        data: {
          request_id: withdrawn.requestId,
          case_id: withdrawn.caseId,
          status: withdrawn.status,
          resolved_at: withdrawn.resolvedAt.toISOString(),
          stage: withdrawn.stage,
        },
      };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) {
        throw reviewConflictError("withdraw this information request", error);
      }
      throw error;
    }
  }
}

export class RecordFounderDecisionService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    traceId: string;
    body: FounderDecisionBody;
  }) {
    const originationCase = await this.repository.getCaseForOperations(input.caseId);
    if (originationCase === null) throw caseNotFoundError();
    if (
      !canRecordFounderDecision({
        stage: originationCase.stage,
        hasCurrentRevision: originationCase.currentRevision !== null,
      })
    ) {
      throw reviewConflictError("record a founder decision");
    }

    const decidedAt = this.clock();
    try {
      const recorded = await this.repository.recordFounderDecision(
        input.body.decision === "approve"
          ? {
              decision: "approve",
              accountId: input.accountId,
              caseId: input.caseId,
              traceId: input.traceId,
              founderReviewNotes: input.body.founder_review_notes,
              decidedAt,
              ipoPeriodDays: input.body.ipo_period_days,
              ipoEndAt: addCalendarDays(decidedAt, input.body.ipo_period_days),
              ipoValueEur: input.body.ipo_value_eur,
            }
          : {
              decision: "reject",
              accountId: input.accountId,
              caseId: input.caseId,
              traceId: input.traceId,
              founderReviewNotes: input.body.founder_review_notes,
              decidedAt,
              rejectionReasonCode: input.body.rejection_reason_code,
              rejectionNotes: input.body.rejection_notes,
            },
      );
      if (recorded === null) throw caseNotFoundError();
      return {
        data: {
          case_id: recorded.caseId,
          stage: recorded.stage,
          decided_at: recorded.decidedAt.toISOString(),
          ipo_end_at: recorded.ipoEndAt?.toISOString() ?? null,
        },
      };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) {
        throw reviewConflictError("record a founder decision", error);
      }
      throw error;
    }
  }
}

// Purely advisory: nothing today reads documentary_screening_evidence.status
// for any decision (canRecordFounderDecision included), and this doesn't
// change that -- it only lets staff record what they found. No case-stage
// restriction either, by the same design call: reviewable at any stage. So,
// unlike RecordFounderDecisionService above, there's no domain-policy check
// here -- existence and case-ownership validation both happen inside
// repository.reviewEvidence's own transaction.
export class ReviewEvidenceService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    evidenceId: string;
    traceId: string;
    body: ReviewEvidenceBody;
  }) {
    const reviewedAt = this.clock();
    try {
      const reviewed = await this.repository.reviewEvidence({
        accountId: input.accountId,
        caseId: input.caseId,
        evidenceId: input.evidenceId,
        traceId: input.traceId,
        status: input.body.status,
        reviewNotes: input.body.review_notes,
        reviewedAt,
      });
      return {
        data: {
          evidence_id: reviewed.evidenceId,
          case_id: reviewed.caseId,
          status: reviewed.status,
          reviewed_by_account_id: reviewed.reviewedByAccountId,
          reviewed_at: reviewed.reviewedAt.toISOString(),
          review_notes: reviewed.reviewNotes,
        },
      };
    } catch (error) {
      if (error instanceof EvidenceNotFoundError) throw evidenceNotFoundError();
      if (error instanceof EvidenceCaseMismatchError) throw evidenceCaseMismatchError(error);
      throw error;
    }
  }
}

// PERMISSION_MATRIX.md: "Reject, withdraw, or expire a case, at any stage" —
// a distinct, later capability from RecordFounderDecisionService's
// submitted-stage-only initial review above. Withdrawal is the applicant's
// own choice in substance (AD-104: "costs the owner nothing"), but the
// applicant-facing lane stays founder-mediated in phase 1
// (PERMISSION_MATRIX.md: owner applicant cannot call this directly), so it's
// recorded here rather than as a self-service endpoint.
export class CloseCaseService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    traceId: string;
    body: CloseCaseBody;
  }) {
    const originationCase = await this.repository.getCaseForOperations(input.caseId);
    if (originationCase === null) throw caseNotFoundError();
    if (!canCloseCase({ stage: originationCase.stage, outcome: input.body.outcome })) {
      throw reviewConflictError("close the case");
    }

    const closedAt = this.clock();
    try {
      const closed = await this.repository.closeCase(
        input.body.outcome === "withdrawn"
          ? {
              outcome: "withdrawn",
              accountId: input.accountId,
              caseId: input.caseId,
              traceId: input.traceId,
              founderReviewNotes: input.body.founder_review_notes,
              closedAt,
            }
          : {
              outcome: "rejected",
              accountId: input.accountId,
              caseId: input.caseId,
              traceId: input.traceId,
              founderReviewNotes: input.body.founder_review_notes,
              rejectionReasonCode: input.body.rejection_reason_code,
              rejectionNotes: input.body.rejection_notes,
              closedAt,
            },
      );
      if (closed === null) throw caseNotFoundError();
      return {
        data: {
          case_id: closed.caseId,
          stage: closed.stage,
          closed_at: closed.closedAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) {
        throw reviewConflictError("close the case", error);
      }
      throw error;
    }
  }
}

// Staff create-and-submit (real estate intake taken by phone/in person).
// Deliberately does not call evaluateIntakeEntry: that also bundles the
// self-KYC/proof-of-address checks staff attest to out-of-band, so this
// re-derives only the property-value floor directly. intake_terms_accepted,
// one_title_confirmed and property_type are guaranteed by the request
// schema's literals, so the only remaining runtime policy check is the
// evidence-shape one (missing/duplicate document types), reused from the
// owner-facing initial submission via evaluateInitialCaseSubmission with a
// synthetic draft/no-revision state -- true by construction for a case that
// doesn't exist yet.
export class CreateStaffOriginationCaseService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    staffAccountId: string;
    traceId: string;
    body: CreateStaffCaseBody;
  }) {
    const submissionDecision = evaluateInitialCaseSubmission({
      stage: "draft",
      hasCurrentRevision: false,
      documentTypes: input.body.documents.map((document) => document.document_type),
    });
    if (!submissionDecision.allowed) {
      throw submissionPolicyError(submissionDecision);
    }

    const minimumPropertyValueEur = await this.repository.getMinimumPropertyValueEur();
    if (
      moneyToCents(input.body.property.owner_declared_value_eur) <
      moneyToCents(minimumPropertyValueEur)
    ) {
      throw propertyValueBelowMinimumError(minimumPropertyValueEur);
    }

    const now = this.clock();
    try {
      const created = await this.repository.createStaffCase({
        applicantAccountId: input.body.applicant_account_id,
        staffAccountId: input.staffAccountId,
        traceId: input.traceId,
        property: {
          countryCode: input.body.property.country_code,
          city: input.body.property.city,
          addressLine: input.body.property.address_line,
          landRegistryReference: input.body.property.land_registry_reference,
          ownerDeclaredValueEur: input.body.property.owner_declared_value_eur,
          hasExistingEncumbrance: input.body.property.has_existing_encumbrance,
          residentialSubtype: input.body.property.residential_subtype,
          livingAreaSqM: input.body.property.living_area_sq_m,
          bedrooms: input.body.property.bedrooms,
          bathrooms: input.body.property.bathrooms,
          floor: input.body.property.floor,
          totalFloors: input.body.property.total_floors,
          yearBuilt: input.body.property.year_built,
          condition: input.body.property.condition,
          energyRating: input.body.property.energy_rating,
          rooms: input.body.property.rooms.map((room) => ({
            roomType: room.room_type,
            sizeSqM: room.size_sq_m,
          })),
        },
        submissionData: {
          attestations: {
            intake_terms_accepted: true,
            one_title_confirmed: true,
            accepted_at: now.toISOString(),
            staff_created: true,
          },
        },
        documents: input.body.documents.map((document) => ({
          documentType: document.document_type,
          documentRef: document.document_ref,
          extractDated:
            document.extract_dated === null ? null : new Date(document.extract_dated),
        })),
      });
      return {
        data: {
          case_id: created.caseId,
          revision_id: created.revisionId,
          revision_number: created.revisionNumber,
          stage: created.stage,
          submitted_at: created.submittedAt.toISOString(),
          applicant_account_id: created.applicantAccountId,
        },
      };
    } catch (error) {
      if (error instanceof ApplicantAccountNotFoundError) {
        throw new AppError({
          code: "origination.applicant_account_not_found",
          title: "Applicant account not found",
          status: 404,
          detail: "No account exists with the given applicant_account_id.",
        });
      }
      throw error;
    }
  }
}

export class AssignPartnerOrganizationService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly partnerOrganizations: PartnerOrganizationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    body: AssignPartnerOrganizationBody;
  }) {
    const assignment = await this.repository.getCasePartnerAssignment(input.caseId);
    if (assignment === null) throw caseNotFoundError();
    if (!canAssignPartnerOrganization({ stage: assignment.stage })) {
      throw reviewConflictError("assign a legal practice or appraisal firm");
    }

    if (input.body.legal_practice_id !== undefined) {
      const practice = await this.partnerOrganizations.getLegalPracticeById(
        input.body.legal_practice_id,
      );
      if (practice === null) throw partnerOrganizationNotFoundError("legal_practice");
      if (practice.status !== "active") throw partnerOrganizationNotActiveError("legal_practice");
    }
    if (input.body.appraisal_firm_id !== undefined) {
      const firm = await this.partnerOrganizations.getAppraisalFirmById(
        input.body.appraisal_firm_id,
      );
      if (firm === null) throw partnerOrganizationNotFoundError("appraisal_firm");
      if (firm.status !== "active") throw partnerOrganizationNotActiveError("appraisal_firm");
    }

    try {
      const assigned = await this.repository.assignPartnerOrganization({
        caseId: input.caseId,
        ...(input.body.legal_practice_id === undefined
          ? {}
          : { legalPracticeId: input.body.legal_practice_id }),
        ...(input.body.appraisal_firm_id === undefined
          ? {}
          : { appraisalFirmId: input.body.appraisal_firm_id }),
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        assignedAt: this.clock(),
      });
      if (assigned === null) throw caseNotFoundError();
      return {
        data: {
          case_id: assigned.caseId,
          legal_practice_id: assigned.legalPracticeId,
          appraisal_firm_id: assigned.appraisalFirmId,
        },
      };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) {
        throw reviewConflictError("assign a legal practice or appraisal firm", error);
      }
      throw error;
    }
  }
}

function toOperationsResponse(input: OperationsCaseDetail) {
  return {
    ...toOwnedCaseResponse(input),
    applicant_account_id: input.applicantAccountId,
    legal_practice_id: input.legalPracticeId,
    appraisal_firm_id: input.appraisalFirmId,
    founder_review: {
      notes: input.founderReviewNotes,
      reviewed_by_account_id: input.reviewedByAccountId,
      approved_at: input.approvedAt?.toISOString() ?? null,
      rejected_at: input.rejectedAt?.toISOString() ?? null,
      rejection_reason_code: input.rejectionReasonCode,
      rejection_notes: input.rejectionNotes,
      ipo_period_days: input.ipoPeriodDays,
      ipo_end_at: input.ipoEndAt?.toISOString() ?? null,
      ipo_value_eur: input.ipoValueEur,
    },
    submission:
      input.submission === null
        ? null
        : {
            revision_id: input.submission.revisionId,
            revision_number: input.submission.revisionNumber,
            submitted_at: input.submission.submittedAt.toISOString(),
            submitted_by_account_id: input.submission.submittedByAccountId,
            submission_data: input.submission.submissionData,
            evidence: input.submission.evidence.map((evidence) => ({
              evidence_id: evidence.evidenceId,
              document_type: evidence.documentType,
              status: evidence.status,
              document_ref: evidence.documentRef,
              extract_dated: evidence.extractDated?.toISOString() ?? null,
              uploaded_at: evidence.uploadedAt.toISOString(),
              reviewed_by_account_id: evidence.reviewedByAccountId,
              reviewed_at: evidence.reviewedAt?.toISOString() ?? null,
              review_notes: evidence.reviewNotes,
            })),
          },
    information_requests: input.informationRequests.map(toInformationRequestResponse),
  };
}

export function toInformationRequestResponse(input: InformationRequestRecord) {
  return {
    request_id: input.requestId,
    status: input.status,
    request_body: input.requestBody,
    published_at: input.publishedAt?.toISOString() ?? null,
    due_at: input.dueAt?.toISOString() ?? null,
    resolved_at: input.resolvedAt?.toISOString() ?? null,
    resolution_type: input.resolutionType,
    resolving_revision_id: input.resolvingRevisionId,
  };
}

function addCalendarDays(start: Date, days: number): Date {
  const result = new Date(start);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function caseNotFoundError(): AppError {
  return new AppError({
    code: "origination.case_not_found",
    title: "Origination case not found",
    status: 404,
    detail: "The requested origination case was not found.",
  });
}

function reviewConflictError(action: string, cause?: unknown): AppError {
  return new AppError({
    code: "origination.review_transition_conflict",
    title: "Review action unavailable",
    status: 409,
    detail: `The case can no longer ${action} from its current stage.`,
    cause,
  });
}

function evidenceNotFoundError(): AppError {
  return new AppError({
    code: "origination.evidence_not_found",
    title: "Evidence not found",
    status: 404,
    detail: "The requested evidence document was not found.",
  });
}

function evidenceCaseMismatchError(cause?: unknown): AppError {
  return new AppError({
    code: "origination.evidence_case_mismatch",
    title: "Evidence does not belong to this case",
    status: 409,
    detail: "The requested evidence document does not belong to the given case.",
    cause,
  });
}

function partnerOrganizationNotFoundError(
  resourceType: "legal_practice" | "appraisal_firm",
): AppError {
  return new AppError({
    code: `origination.${resourceType}_not_found`,
    title: "Partner organization not found",
    status: 404,
    detail: `No ${resourceType.replace("_", " ")} exists with the given id.`,
  });
}

function submissionPolicyError(
  decision: Exclude<ReturnType<typeof evaluateInitialCaseSubmission>, { allowed: true }>,
): AppError {
  if (decision.reason === "missing_evidence") {
    return new AppError({
      code: "origination.required_evidence_missing",
      title: "Required intake evidence missing",
      status: 422,
      detail: `Required initial evidence is missing: ${decision.missingEvidence?.join(", ")}.`,
      fieldErrors: (decision.missingEvidence ?? []).map((documentType) => ({
        field: "documents",
        code: "evidence.required",
        message: `${documentType} is required.`,
      })),
    });
  }
  if (decision.reason === "duplicate_evidence") {
    return new AppError({
      code: "origination.duplicate_evidence_type",
      title: "Duplicate evidence type",
      status: 422,
      detail: "Each evidence type may appear only once in an initial submission.",
    });
  }
  return new AppError({
    code: "origination.case_submission_conflict",
    title: "Case cannot be submitted",
    status: 409,
    detail: "Only a draft case without a submission revision can be initially submitted.",
  });
}

function propertyValueBelowMinimumError(minimumValue: string): AppError {
  return new AppError({
    code: "origination.property_value_below_minimum",
    title: "Property value below minimum",
    status: 422,
    detail: `The owner-declared property value must be at least EUR ${minimumValue}.`,
    fieldErrors: [
      {
        field: "property.owner_declared_value_eur",
        code: "number.min",
        message: `Value must be at least EUR ${minimumValue}.`,
      },
    ],
  });
}

function moneyToCents(value: string): bigint {
  const [euros, cents] = value.split(".");
  if (euros === undefined || cents === undefined) throw new Error("Invalid money value");
  return BigInt(euros) * 100n + BigInt(cents);
}

function partnerOrganizationNotActiveError(
  resourceType: "legal_practice" | "appraisal_firm",
): AppError {
  return new AppError({
    code: `origination.${resourceType}_not_active`,
    title: "Partner organization not active",
    status: 409,
    detail: `This ${resourceType.replace("_", " ")} is suspended and cannot be assigned to a case.`,
  });
}
