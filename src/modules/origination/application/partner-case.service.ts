import { AppError } from "../../../shared/errors/app-error.js";
import type { AccountRepository } from "../../account/repository/account.repository.js";
import type {
  PartnerCaseListQuery,
  PartnerCaseResponse,
  RecordAppraisalBody,
  RecordLegalStructuringBody,
} from "../api/partner-case.schemas.js";
import { originationCaseStageSchema } from "../api/origination.schemas.js";
import { canRecordPartnerWriteback } from "../domain/case-review.policy.js";
import {
  CaseReviewConflictError,
  type OriginationRepository,
  type PartnerCaseDetail,
} from "../repository/origination.repository.js";
import { decodeCaseCursor, encodeCaseCursor } from "./read-own-cases.service.js";

export class ListCasesForPartnerService {
  public constructor(
    private readonly role: "legal_partner" | "appraisal_partner",
    private readonly accounts: AccountRepository,
    private readonly cases: OriginationRepository,
  ) {}

  public async execute(input: {
    accountId: string;
    query: PartnerCaseListQuery;
  }): Promise<{ data: PartnerCaseResponse[]; page: { next_cursor: string | null } }> {
    const organizationId = await this.accounts.getActivePartnerOrganizationId(
      input.accountId,
      this.role,
    );
    // No active assignment at all -- rather than an error, an empty list:
    // the same "nothing to see" a founder gets from an empty operations
    // filter, not a 403 (the role-check middleware already covers "can this
    // account act as this role at all").
    if (organizationId === null) {
      return { data: [], page: { next_cursor: null } };
    }

    const after = input.query.after === undefined ? undefined : decodeCaseCursor(input.query.after);
    const rows = await this.cases.listCasesForPartner({
      role: this.role,
      organizationId,
      limit: input.query.limit + 1,
      ...(after === undefined ? {} : { after }),
    });
    const hasNextPage = rows.length > input.query.limit;
    const pageRows = hasNextPage ? rows.slice(0, input.query.limit) : rows;
    const last = pageRows.at(-1);

    return {
      data: pageRows.map(toPartnerCaseResponse),
      page: {
        next_cursor:
          hasNextPage && last !== undefined
            ? encodeCaseCursor({ createdAt: last.createdAt, id: last.caseId })
            : null,
      },
    };
  }
}

export class GetCaseForPartnerService {
  public constructor(private readonly repository: OriginationRepository) {}

  public async execute(caseId: string): Promise<{ data: PartnerCaseResponse }> {
    const originationCase = await this.repository.getCaseForPartner(caseId);
    if (originationCase === null) throw caseNotFoundError();
    return { data: toPartnerCaseResponse(originationCase) };
  }
}

export class RecordLegalStructuringService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    body: RecordLegalStructuringBody;
  }): Promise<{ data: PartnerCaseResponse }> {
    const assignment = await this.repository.getCasePartnerAssignment(input.caseId);
    if (assignment === null) throw caseNotFoundError();
    if (!canRecordPartnerWriteback({ stage: assignment.stage })) {
      throw reviewConflictError("record legal structuring");
    }

    try {
      const recorded = await this.repository.recordLegalStructuring({
        caseId: input.caseId,
        ...(input.body.legal_document_refs === undefined
          ? {}
          : { legalDocumentRefs: input.body.legal_document_refs }),
        ...(input.body.mark_completed === undefined ? {} : { markCompleted: input.body.mark_completed }),
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        recordedAt: this.clock(),
      });
      if (recorded === null) throw caseNotFoundError();
      return { data: toPartnerCaseResponse(recorded) };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) {
        throw reviewConflictError("record legal structuring", error);
      }
      throw error;
    }
  }
}

export class RecordAppraisalService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    caseId: string;
    actorAccountId: string;
    traceId: string;
    body: RecordAppraisalBody;
  }): Promise<{ data: PartnerCaseResponse }> {
    const assignment = await this.repository.getCasePartnerAssignment(input.caseId);
    if (assignment === null) throw caseNotFoundError();
    if (!canRecordPartnerWriteback({ stage: assignment.stage })) {
      throw reviewConflictError("record an appraisal");
    }

    try {
      const recorded = await this.repository.recordAppraisal({
        caseId: input.caseId,
        ...(input.body.appraisal_value_opinion_eur === undefined
          ? {}
          : { appraisalValueOpinionEur: input.body.appraisal_value_opinion_eur }),
        ...(input.body.appraisal_document_refs === undefined
          ? {}
          : { appraisalDocumentRefs: input.body.appraisal_document_refs }),
        ...(input.body.mark_completed === undefined ? {} : { markCompleted: input.body.mark_completed }),
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        recordedAt: this.clock(),
      });
      if (recorded === null) throw caseNotFoundError();
      return { data: toPartnerCaseResponse(recorded) };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) {
        throw reviewConflictError("record an appraisal", error);
      }
      throw error;
    }
  }
}

function toPartnerCaseResponse(input: PartnerCaseDetail): PartnerCaseResponse {
  return {
    case_id: input.caseId,
    stage: originationCaseStageSchema.parse(input.stage),
    created_at: input.createdAt.toISOString(),
    updated_at: input.updatedAt.toISOString(),
    current_revision:
      input.currentRevision === null
        ? null
        : {
            revision_number: input.currentRevision.revisionNumber,
            submitted_at: input.currentRevision.submittedAt.toISOString(),
          },
    property: {
      property_id: input.property.propertyId,
      property_type: "residential",
      country_code: input.property.countryCode,
      city: input.property.city,
      address_line: input.property.addressLine,
      land_registry_reference: input.property.landRegistryReference,
      owner_declared_value_eur: input.property.ownerDeclaredValueEur,
      has_existing_encumbrance: input.property.hasExistingEncumbrance,
    },
    legal_document_refs: input.legalDocumentRefs,
    legal_structuring_completed_at: input.legalStructuringCompletedAt?.toISOString() ?? null,
    appraisal_value_opinion_eur: input.appraisalValueOpinionEur,
    appraisal_document_refs: input.appraisalDocumentRefs,
    appraisal_completed_at: input.appraisalCompletedAt?.toISOString() ?? null,
    post_ipo_structuring_completed_at: input.postIpoStructuringCompletedAt?.toISOString() ?? null,
  };
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
