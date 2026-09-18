import { AppError } from "../../../shared/errors/app-error.js";
import type { SubmitInitialCaseBody } from "../api/intake.schemas.js";
import { evaluateCaseResubmission } from "../domain/case-submission.policy.js";
import { evaluateIntakeEntry } from "../domain/intake-entry.policy.js";
import {
  CaseReviewConflictError,
  type InformationRequestRecord,
  type IntakeRepository,
} from "../repository/intake.repository.js";
import { toInformationRequestResponse } from "./operations-case.service.js";

export class ListOwnInformationRequestsService {
  public constructor(private readonly repository: IntakeRepository) {}

  public async execute(accountId: string, caseId: string) {
    const requests = await this.repository.listOwnedInformationRequests(accountId, caseId);
    if (requests === null) throw caseNotFoundError();
    return {
      data: requests.map((request) => {
        const response = toInformationRequestResponse(request);
        if (response.published_at === null || response.due_at === null) {
          throw new Error("Applicant-visible information request is not published");
        }
        return { ...response, case_id: request.caseId };
      }),
    };
  }
}

export class RespondToInformationRequestService {
  public constructor(
    private readonly repository: IntakeRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    requestId: string;
    traceId: string;
    body: SubmitInitialCaseBody;
  }) {
    const [intakeCase, request, prerequisites] = await Promise.all([
      this.repository.getOwnedCase(input.accountId, input.caseId),
      this.repository.getOwnedInformationRequest(
        input.accountId,
        input.caseId,
        input.requestId,
      ),
      this.repository.getIntakePrerequisites(input.accountId),
    ]);
    if (intakeCase === null || request === null) throw caseNotFoundError();

    const submissionDecision = evaluateCaseResubmission({
      stage: intakeCase.stage,
      hasCurrentRevision: intakeCase.currentRevision !== null,
      requestStatus: request.status,
      documentTypes: input.body.documents.map((document) => document.document_type),
    });
    if (!submissionDecision.allowed) {
      if (submissionDecision.reason === "missing_evidence") {
        throw new AppError({
          code: "intake.required_evidence_missing",
          title: "Required intake evidence missing",
          status: 422,
          detail: `Required resubmission evidence is missing: ${submissionDecision.missingEvidence?.join(", ")}.`,
        });
      }
      if (submissionDecision.reason === "duplicate_evidence") {
        throw new AppError({
          code: "intake.duplicate_evidence_type",
          title: "Duplicate evidence type",
          status: 422,
          detail: "Each evidence type may appear only once in a resubmission.",
        });
      }
      throw responseConflictError();
    }

    const submittedAt = this.clock();
    const eligibility = evaluateIntakeEntry({
      eligibilityState: prerequisites.eligibilityState,
      proofOfAddressCurrentUntil: prerequisites.proofOfAddressCurrentUntil,
      now: submittedAt,
      declaredValueCents: moneyToCents(intakeCase.property.ownerDeclaredValueEur),
      minimumValueCents: moneyToCents(prerequisites.minimumPropertyValueEur),
      intakeTermsAccepted: input.body.intake_terms_accepted,
      oneTitleConfirmed: input.body.one_title_confirmed,
      propertyType: intakeCase.property.propertyType,
    });
    if (!eligibility.allowed) {
      throw new AppError({
        code: `intake.resubmission_${eligibility.reason}`,
        title: "Case resubmission requirements not met",
        status:
          eligibility.reason === "kyc_not_eligible" ||
          eligibility.reason === "proof_of_address_required"
            ? 403
            : 422,
        detail: "The case no longer meets owner intake requirements.",
      });
    }

    try {
      const submitted = await this.repository.resubmitAfterInformationRequest({
        accountId: input.accountId,
        caseId: input.caseId,
        requestId: input.requestId,
        traceId: input.traceId,
        submittedAt,
        submissionData: {
          ...input.body.submission_data,
          attestations: {
            intake_terms_accepted: true,
            one_title_confirmed: true,
            accepted_at: submittedAt.toISOString(),
          },
          response_to_information_request_id: input.requestId,
        },
        documents: input.body.documents.map((document) => ({
          documentType: document.document_type,
          documentRef: document.document_ref,
          extractDated:
            document.extract_dated === null ? null : new Date(document.extract_dated),
        })),
      });
      if (submitted === null) throw caseNotFoundError();
      return {
        data: {
          case_id: submitted.caseId,
          revision_id: submitted.revisionId,
          revision_number: submitted.revisionNumber,
          stage: submitted.stage,
          submitted_at: submitted.submittedAt.toISOString(),
          resolved_request_id: input.requestId,
        },
      };
    } catch (error) {
      if (error instanceof CaseReviewConflictError) throw responseConflictError(error);
      throw error;
    }
  }
}

function caseNotFoundError(): AppError {
  return new AppError({
    code: "intake.case_not_found",
    title: "Intake case not found",
    status: 404,
    detail: "The requested intake case or information request was not found.",
  });
}

function responseConflictError(cause?: unknown): AppError {
  return new AppError({
    code: "intake.information_request_response_conflict",
    title: "Information request cannot be answered",
    status: 409,
    detail: "Only the current published request on a waiting case can be answered.",
    cause,
  });
}

function moneyToCents(value: string): bigint {
  const [euros, cents] = value.split(".");
  if (euros === undefined || cents === undefined) throw new Error("Invalid money value");
  return BigInt(euros) * 100n + BigInt(cents);
}
