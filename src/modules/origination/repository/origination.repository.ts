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

// REAL_ESTATE_INTAKE_LIFECYCLE.md's Thread Rules (AD-244's 2026-08-29
// update): exactly three fixed lanes per case, no ad hoc ones.
// system_timeline is system-generated and append-only, not a human-postable
// chat lane, so it has no place in this type — nothing writes to it yet.
export type ThreadLane = "internal_case" | "applicant";

export interface CaseMessageRecord {
  messageId: string;
  authorAccountId: string | null;
  body: string;
  createdAt: Date;
}

// A minimal, auth-check-sized projection -- deliberately not
// OperationsCaseDetail, which carries founder review notes and other
// pre-IPO data a legal/appraisal partner middleware has no business
// touching even transiently.
export interface CasePartnerAssignment {
  stage: string;
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
}

export interface AssignPartnerOrganizationInput {
  caseId: string;
  legalPracticeId?: string;
  appraisalFirmId?: string;
  actorAccountId: string;
  traceId: string;
  assignedAt: Date;
}

export interface AssignedPartnerOrganization {
  caseId: string;
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
}

// The partner-facing projection: everything a legal/appraisal partner is
// allowed to see once createRequirePartnerCaseAssignment has already gated
// access, deliberately excluding OperationsCaseDetail's founder-only fields
// (founder_review_notes, ipo_value_eur, applicant identity, etc. --
// PERMISSION_MATRIX.md's Protected Case Areas) by construction rather than
// by filtering a bigger object down. Both partner roles see both
// workstreams' fields read-only -- only the write side is
// per-role-restricted (PERMISSION_MATRIX.md's Partner Writeback Allowlist).
export interface PartnerCaseDetail extends OwnedOriginationCase {
  legalDocumentRefs: string[];
  legalStructuringCompletedAt: Date | null;
  appraisalValueOpinionEur: string | null;
  appraisalDocumentRefs: string[];
  appraisalCompletedAt: Date | null;
  postIpoStructuringCompletedAt: Date | null;
}

export interface RecordLegalStructuringInput {
  caseId: string;
  legalDocumentRefs?: string[];
  markCompleted?: boolean;
  actorAccountId: string;
  traceId: string;
  recordedAt: Date;
}

export interface RecordAppraisalInput {
  caseId: string;
  appraisalValueOpinionEur?: string;
  appraisalDocumentRefs?: string[];
  markCompleted?: boolean;
  actorAccountId: string;
  traceId: string;
  recordedAt: Date;
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
  getCasePartnerAssignment(caseId: string): Promise<CasePartnerAssignment | null>;
  // Throws CaseReviewConflictError if the case's stage no longer allows
  // partner assignment by the time this actually runs (the FOR UPDATE-locked
  // recheck inside the transaction), matching every other stage-guarded
  // write in this repository. Returns null only if the case has vanished
  // entirely between the caller's own check and this call.
  assignPartnerOrganization(
    input: AssignPartnerOrganizationInput,
  ): Promise<AssignedPartnerOrganization | null>;
  // Filtered server-side by the caller's own organization id and role --
  // never client-suppliable -- and by the same accessible-stage set
  // require-partner-case-assignment.ts's middleware already enforces for a
  // single case, so a partner's list can never surface a case their
  // organization isn't assigned to or that hasn't reached that stage.
  listCasesForPartner(input: {
    role: "legal_partner" | "appraisal_partner";
    organizationId: string;
    limit: number;
    after?: OriginationCaseCursor;
  }): Promise<PartnerCaseDetail[]>;
  // No role/organization parameter: createRequirePartnerCaseAssignment
  // already fully gates access before this runs, the same
  // scoping-happens-one-level-up split listCaseMessages/postCaseMessage
  // below already use.
  getCaseForPartner(caseId: string): Promise<PartnerCaseDetail | null>;
  // Throws CaseReviewConflictError once the case is no longer at
  // post_ipo_structuring (canRecordPartnerWriteback's own recheck under
  // lock) -- including once it has already advanced to
  // approved_for_final_offering, unlike assignPartnerOrganization, which
  // stays open at that later stage. Returns null only if the case has
  // vanished entirely since the caller's own check.
  recordLegalStructuring(input: RecordLegalStructuringInput): Promise<PartnerCaseDetail | null>;
  recordAppraisal(input: RecordAppraisalInput): Promise<PartnerCaseDetail | null>;
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
  // Ownership/existence scoping happens one level up (getOwnedCase for the
  // applicant-lane owner routes, getCaseForOperations for staff), matching
  // how every other write here separates that check from the write itself
  // — so these two operate on caseId directly, usable from either side.
  listCaseMessages(caseId: string, lane: ThreadLane): Promise<CaseMessageRecord[]>;
  postCaseMessage(input: {
    caseId: string;
    lane: ThreadLane;
    authorAccountId: string;
    body: string;
    postedAt: Date;
  }): Promise<CaseMessageRecord | null>;
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
