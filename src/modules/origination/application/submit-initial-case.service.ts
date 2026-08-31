import { AppError } from "../../../shared/errors/app-error.js";
import type { SubmitInitialCaseBody } from "../api/origination.schemas.js";
import { evaluateInitialCaseSubmission } from "../domain/case-submission.policy.js";
import { evaluateIntakeEntry } from "../domain/intake-entry.policy.js";
import {
  CaseSubmissionConflictError,
  type OriginationRepository,
} from "../repository/origination.repository.js";

export class SubmitInitialCaseService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    traceId: string;
    body: SubmitInitialCaseBody;
  }) {
    const [originationCase, prerequisites] = await Promise.all([
      this.repository.getOwnedCase(input.accountId, input.caseId),
      this.repository.getIntakePrerequisites(input.accountId),
    ]);
    if (originationCase === null) {
      throw caseNotFoundError();
    }

    const submissionDecision = evaluateInitialCaseSubmission({
      stage: originationCase.stage,
      hasCurrentRevision: originationCase.currentRevision !== null,
      documentTypes: input.body.documents.map((document) => document.document_type),
    });
    if (!submissionDecision.allowed) {
      throw submissionPolicyError(submissionDecision);
    }

    const now = this.clock();
    const intakeDecision = evaluateIntakeEntry({
      eligibilityState: prerequisites.eligibilityState,
      proofOfAddressCurrentUntil: prerequisites.proofOfAddressCurrentUntil,
      now,
      declaredValueCents: moneyToCents(originationCase.property.ownerDeclaredValueEur),
      minimumValueCents: moneyToCents(prerequisites.minimumPropertyValueEur),
      intakeTermsAccepted: input.body.intake_terms_accepted,
      oneTitleConfirmed: input.body.one_title_confirmed,
      propertyType: originationCase.property.propertyType,
    });
    if (!intakeDecision.allowed) {
      throw intakeRecheckError(intakeDecision.reason, prerequisites.minimumPropertyValueEur);
    }

    try {
      const submitted = await this.repository.submitInitialCase({
        accountId: input.accountId,
        caseId: input.caseId,
        traceId: input.traceId,
        submissionData: {
          ...input.body.submission_data,
          attestations: {
            intake_terms_accepted: true,
            one_title_confirmed: true,
            accepted_at: now.toISOString(),
          },
        },
        documents: input.body.documents.map((document) => ({
          documentType: document.document_type,
          documentRef: document.document_ref,
          extractDated:
            document.extract_dated === null ? null : new Date(document.extract_dated),
        })),
      });
      if (submitted === null) {
        throw caseNotFoundError();
      }
      return {
        data: {
          case_id: submitted.caseId,
          revision_id: submitted.revisionId,
          revision_number: submitted.revisionNumber,
          stage: submitted.stage,
          submitted_at: submitted.submittedAt.toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof CaseSubmissionConflictError) {
        throw new AppError({
          code: "origination.case_submission_conflict",
          title: "Case cannot be submitted",
          status: 409,
          detail: `The case can no longer be submitted from its current ${error.currentStage} stage.`,
          cause: error,
        });
      }
      throw error;
    }
  }
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

function intakeRecheckError(reason: string, minimumValue: string): AppError {
  const detailByReason: Record<string, string> = {
    kyc_not_eligible: "Eligible KYC status is required at submission time.",
    proof_of_address_required: "Current proof of address is required at submission time.",
    property_value_below_minimum: `The property value must still meet the EUR ${minimumValue} floor.`,
  };
  return new AppError({
    code: `origination.submission_${reason}`,
    title: "Case submission requirements not met",
    status: reason === "kyc_not_eligible" || reason === "proof_of_address_required" ? 403 : 422,
    detail: detailByReason[reason] ?? "The case no longer meets intake requirements.",
  });
}

function caseNotFoundError(): AppError {
  return new AppError({
    code: "origination.case_not_found",
    title: "Origination case not found",
    status: 404,
    detail: "The requested origination case was not found.",
  });
}

function moneyToCents(value: string): bigint {
  const [euros, cents] = value.split(".");
  if (euros === undefined || cents === undefined) throw new Error("Invalid money value");
  return BigInt(euros) * 100n + BigInt(cents);
}
