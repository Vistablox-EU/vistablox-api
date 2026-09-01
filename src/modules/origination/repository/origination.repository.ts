export interface IntakePrerequisites {
  eligibilityState: string;
  proofOfAddressCurrentUntil: Date | null;
  minimumPropertyValueEur: string;
}

export interface CreateDraftIntakeInput {
  accountId: string;
  traceId: string;
  property: {
    countryCode: string;
    city: string | null;
    addressLine: string | null;
    landRegistryReference: string | null;
    latitude: number | null;
    longitude: number | null;
    ownerDeclaredValueEur: string;
    hasExistingEncumbrance: boolean;
  };
}

export interface CreatedDraftIntake {
  caseId: string;
  propertyId: string;
  stage: "draft";
}

export interface OriginationCaseCursor {
  createdAt: Date;
  id: string;
}

export interface OwnedOriginationCase {
  caseId: string;
  stage: string;
  createdAt: Date;
  updatedAt: Date;
  currentRevision: {
    revisionNumber: number;
    submittedAt: Date;
  } | null;
  property: {
    propertyId: string;
    propertyType: string;
    countryCode: string;
    city: string | null;
    addressLine: string | null;
    landRegistryReference: string | null;
    ownerDeclaredValueEur: string;
    hasExistingEncumbrance: boolean;
  };
}

export interface SubmissionDocumentInput {
  documentType: string;
  documentRef: string;
  extractDated: Date | null;
}

export interface SubmitInitialCaseInput {
  accountId: string;
  caseId: string;
  traceId: string;
  submissionData: Record<string, unknown>;
  documents: SubmissionDocumentInput[];
}

export interface SubmittedCase {
  caseId: string;
  revisionId: string;
  revisionNumber: number;
  stage: "submitted";
  submittedAt: Date;
}

export interface InformationRequestRecord {
  requestId: string;
  caseId: string;
  status: string;
  requestBody: string;
  publishedAt: Date | null;
  dueAt: Date | null;
  resolvedAt: Date | null;
  resolutionType: string | null;
  resolvingRevisionId: string | null;
}

export interface OperationsCaseDetail extends OwnedOriginationCase {
  applicantAccountId: string;
  founderReviewNotes: string | null;
  reviewedByAccountId: string | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReasonCode: string | null;
  rejectionNotes: string | null;
  ipoPeriodDays: number | null;
  ipoEndAt: Date | null;
  ipoValueEur: string | null;
  submission: {
    revisionId: string;
    revisionNumber: number;
    submittedAt: Date;
    submittedByAccountId: string;
    submissionData: unknown;
    evidence: Array<{
      evidenceId: string;
      documentType: string;
      status: string;
      documentRef: string;
      extractDated: Date | null;
      uploadedAt: Date;
    }>;
  } | null;
  informationRequests: InformationRequestRecord[];
}

export interface PublishedInformationRequest extends InformationRequestRecord {
  status: "published";
  publishedAt: Date;
  dueAt: Date;
}

export type ResubmittedCase = SubmittedCase;

export interface PublishedInformationRequestForTimer {
  requestId: string;
  caseId: string;
  applicantAccountId: string;
  applicantContactEmail: string | null;
  publishedAt: Date;
  dueAt: Date;
}

export type FounderDecisionInput =
  | {
      decision: "approve";
      accountId: string;
      caseId: string;
      traceId: string;
      founderReviewNotes: string;
      decidedAt: Date;
      ipoPeriodDays: number;
      ipoEndAt: Date;
      ipoValueEur: string;
    }
  | {
      decision: "reject";
      accountId: string;
      caseId: string;
      traceId: string;
      founderReviewNotes: string;
      decidedAt: Date;
      rejectionReasonCode: string;
      rejectionNotes: string;
    };

export interface RecordedFounderDecision {
  caseId: string;
  stage: "pre_offering_open" | "rejected";
  decidedAt: Date;
  ipoEndAt: Date | null;
}

export type CloseCaseInput =
  | {
      outcome: "withdrawn";
      accountId: string;
      caseId: string;
      traceId: string;
      founderReviewNotes: string;
      closedAt: Date;
    }
  | {
      outcome: "rejected";
      accountId: string;
      caseId: string;
      traceId: string;
      founderReviewNotes: string;
      rejectionReasonCode: string;
      rejectionNotes: string;
      closedAt: Date;
    };

export interface ClosedCase {
  caseId: string;
  stage: "withdrawn" | "rejected";
  closedAt: Date;
}

export interface OriginationRepository {
  getIntakePrerequisites(accountId: string): Promise<IntakePrerequisites>;
  createDraftIntake(input: CreateDraftIntakeInput): Promise<CreatedDraftIntake>;
  listOwnedCases(input: {
    accountId: string;
    limit: number;
    after?: OriginationCaseCursor;
  }): Promise<OwnedOriginationCase[]>;
  getOwnedCase(accountId: string, caseId: string): Promise<OwnedOriginationCase | null>;
  submitInitialCase(input: SubmitInitialCaseInput): Promise<SubmittedCase | null>;
  listCasesForOperations(input: {
    limit: number;
    stage?: string;
    after?: OriginationCaseCursor;
  }): Promise<OwnedOriginationCase[]>;
  getCaseForOperations(caseId: string): Promise<OperationsCaseDetail | null>;
  getApplicantResponseWindowBusinessDays(): Promise<number>;
  getInformationRequestReminderBusinessDays(): Promise<number[]>;
  publishInformationRequest(input: {
    accountId: string;
    caseId: string;
    traceId: string;
    requestBody: string;
    publishedAt: Date;
    dueAt: Date;
  }): Promise<PublishedInformationRequest | null>;
  getOwnedInformationRequest(
    accountId: string,
    caseId: string,
    requestId: string,
  ): Promise<InformationRequestRecord | null>;
  listOwnedInformationRequests(
    accountId: string,
    caseId: string,
  ): Promise<InformationRequestRecord[] | null>;
  resubmitAfterInformationRequest(input: SubmitInitialCaseInput & {
    requestId: string;
    submittedAt: Date;
  }): Promise<ResubmittedCase | null>;
  recordFounderDecision(
    input: FounderDecisionInput,
  ): Promise<RecordedFounderDecision | null>;
  closeCase(input: CloseCaseInput): Promise<ClosedCase | null>;
  listPublishedInformationRequestsForTimers(): Promise<PublishedInformationRequestForTimer[]>;
  expireInformationRequest(input: {
    requestId: string;
    caseId: string;
    traceId: string;
    expiredAt: Date;
  }): Promise<boolean>;
}

export class CaseSubmissionConflictError extends Error {
  public constructor(public readonly currentStage: string) {
    super(`Case cannot be initially submitted from stage ${currentStage}`);
    this.name = "CaseSubmissionConflictError";
  }
}

export class CaseReviewConflictError extends Error {
  public constructor(
    public readonly currentStage: string,
    public readonly action: string,
  ) {
    super(`Case cannot ${action} from stage ${currentStage}`);
    this.name = "CaseReviewConflictError";
  }
}
