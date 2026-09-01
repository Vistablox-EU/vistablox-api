import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CloseCaseBody,
  FounderDecisionBody,
  OperationsCaseListQuery,
  PublishInformationRequestBody,
} from "../api/origination-operations.schemas.js";
import { originationCaseStageSchema } from "../api/origination.schemas.js";
import {
  addBusinessDays,
  canCloseCase,
  canRecordFounderDecision,
  evaluateInformationRequestPublication,
} from "../domain/case-review.policy.js";
import {
  CaseReviewConflictError,
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

function toOperationsResponse(input: OperationsCaseDetail) {
  return {
    ...toOwnedCaseResponse(input),
    applicant_account_id: input.applicantAccountId,
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
