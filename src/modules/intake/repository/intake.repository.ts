import type {
  TransitionedToPostIpoStructuring,
  TransitionToPostIpoStructuringInput,
} from "./post-ipo-structuring-handoff.repository.js";

export interface IntakePrerequisites {
  eligibilityState: string;
  proofOfAddressCurrentUntil: Date | null;
  minimumPropertyValueEur: string;
}

// Shared by every property-shaped input/output below so all four stay in
// lockstep -- property_type itself stays out of this (still locked to
// "residential" by AD-081, unrelated to these fields).
export interface StructuredPropertyDetails {
  residentialSubtype: string | null;
  livingAreaSqM: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floor: number | null;
  totalFloors: number | null;
  yearBuilt: number | null;
  condition: string | null;
  energyRating: string | null;
}

// A per-room breakdown, additive alongside StructuredPropertyDetails'
// bedrooms/bathrooms aggregate counts -- not a replacement. Input and
// output shapes diverge (a room only gets a stable id once persisted), so
// this isn't folded into StructuredPropertyDetails above.
export interface PropertyRoomInput {
  roomType: string;
  sizeSqM: number;
}

export interface PropertyRoomDetail extends PropertyRoomInput {
  roomId: string;
  preferredPhotoId?: string | null;
  photos?: Array<{
    documentId: string;
    documentRef: string;
    thumbnailRef?: string | null;
    contentType: string;
    uploadedAt: Date;
  }>;
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
    rooms: PropertyRoomInput[];
  } & StructuredPropertyDetails;
}

export interface CreatedDraftIntake {
  caseId: string;
  propertyId: string;
  stage: "draft";
}

export interface CreateStaffCaseInput {
  applicantAccountId: string;
  staffAccountId: string;
  traceId: string;
  property: {
    countryCode: string;
    city: string | null;
    addressLine: string | null;
    landRegistryReference: string | null;
    ownerDeclaredValueEur: string;
    hasExistingEncumbrance: boolean;
    rooms: PropertyRoomInput[];
  } & StructuredPropertyDetails;
  submissionData: Record<string, unknown>;
  documents: SubmissionDocumentInput[];
}

export interface CreatedStaffCase {
  caseId: string;
  revisionId: string;
  revisionNumber: 1;
  stage: "submitted";
  submittedAt: Date;
  applicantAccountId: string;
}

export interface IntakeCaseCursor {
  createdAt: Date;
  id: string;
}

export interface OwnedIntakeCase {
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
    rooms: PropertyRoomDetail[];
  } & StructuredPropertyDetails;
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

export interface OperationsCaseDetail extends OwnedIntakeCase {
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
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
  // The case's own PIV's most recent Offering (Piv -> Offering is a
  // one-to-many relation in the schema, though nothing in the application
  // today creates a second Offering for an existing Piv -- see
  // openOfferingForApprovedCase's reuse-existing-before-create-new logic).
  // Null until the post-approval intake-to-offering handoff
  // (AD-145/AD-152) has actually opened one. This is exactly the field the
  // staff detail view uses to surface a stuck post-IPO handoff: a case
  // sitting at pre_offering_open whose offering already has
  // final_offering_published_at set is a case whose automatic handoff job
  // should have fired but didn't.
  offering: {
    offeringId: string;
    status: string;
    finalOfferingPublishedAt: Date | null;
  } | null;
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
      reviewedByAccountId: string | null;
      reviewedAt: Date | null;
      reviewNotes: string | null;
    }>;
  } | null;
  informationRequests: InformationRequestRecord[];
}

/** Read-only projection used by the operations readiness screen. */
export interface OperationsReadinessSnapshot {
  caseId: string;
  stage: string;
  submission: {
    revisionNumber: number;
    evidence: Array<{ documentType: string; status: string }>;
  } | null;
  legalPracticeId: string | null;
  legalStructuringCompletedAt: Date | null;
  appraisalFirmId: string | null;
  appraisalCompletedAt: Date | null;
  founder: {
    reviewedByAccountId: string | null;
    approvedAt: Date | null;
    rejectedAt: Date | null;
    ipoPeriodDays: number | null;
    ipoValueEur: string | null;
    ipoEndAt: Date | null;
  };
  offering: null | {
    offeringId: string;
    status: string;
    minimumRaiseEur: string;
    targetRaiseEur: string;
    finalOfferingPublishedAt: Date | null;
    platformRightsEndAt: Date | null;
    effectiveRightsEndAt: Date | null;
    disclosurePack: null | {
      id: string;
      version: number;
      publishedAt: Date;
      documentTypes: string[];
    };
    reservations: Array<{
      stage: string;
      amountEur: string;
      latestCapitalState: string | null;
      latestAmountEur: string | null;
    }>;
  };
}

export interface IntakeWorkflowSnapshot {
  caseId: string;
  stage: string;
  createdAt: Date;
  updatedAt: Date;
  currentRevisionNumber: number | null;
  reviewedByAccountId: string | null;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  ipoPeriodDays: number | null;
  ipoEndAt: Date | null;
  ipoValueEur: string | null;
  rejectionReasonCode: string | null;
  legalPracticeId: string | null;
  appraisalFirmId: string | null;
  legalStructuringCompletedAt: Date | null;
  appraisalCompletedAt: Date | null;
  postIpoStructuringCompletedAt: Date | null;
  offering: { offeringId: string; status: string; targetRaiseEur: string; finalOfferingPublishedAt: Date | null } | null;
  informationRequests: Array<{
    requestId: string;
    status: string;
    publishedAt: Date | null;
    dueAt: Date | null;
    resolvedAt: Date | null;
  }>;
}

export interface IntakeCaseHistoryEvent {
  eventId: string;
  eventSequence: number;
  eventType: string;
  workflowType: string;
  workflowVersion: number;
  fromStage: string | null;
  toStage: string | null;
  actorType: string;
  actorAccountId: string | null;
  occurredAt: Date;
  eventSource: string;
  relatedResourceType: string | null;
  relatedResourceId: string | null;
  metadata: unknown;
}

export interface IntakeReversalSnapshot {
  caseId: string;
  stage: string;
  workflowEventSequence: number;
  latestTransition: { eventId: string; fromStage: string; toStage: string } | null;
  activeInformationRequest: boolean;
  offering: {
    offeringId: string;
    status: string;
    finalOfferingPublishedAt: Date | null;
    reservationCount: number;
    fundedReservationCount: number;
    disclosurePackPublished: boolean;
    reconfirmationOpen: boolean;
    finalizedReservationCount: number;
  } | null;
  legalExecutionCompleted: boolean;
  appraisalCompleted: boolean;
  correctionInProgress: boolean;
}

export interface IntakeReversalOperationRecord {
  operationId: string;
  caseId: string;
  command: string;
  fromStage: string;
  toStage: string;
  status: string;
  reasonCode: string;
  reason: string;
  requestedByAccountId: string;
  approvedByAccountId: string | null;
  expectedStage: string;
  expectedWorkflowEventSequence: number;
  reversalOfEventId: string | null;
  idempotencyKey: string;
  createdAt: Date;
  approvedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  failureCode: string | null;
  failureDetail: string | null;
}

// The three terminal outcomes a review can record -- "pending" isn't
// reviewable-into, it's only ever the starting value nothing has touched
// yet (documentary_screening_evidence_status_check and this migration's
// _review_consistency_check both enforce that pairing at the DB level).
export type EvidenceReviewStatus =
  "accepted" | "rejected" | "mandatory_missing";

export interface ReviewEvidenceInput {
  accountId: string;
  caseId: string;
  evidenceId: string;
  traceId: string;
  status: EvidenceReviewStatus;
  reviewNotes: string | null;
  reviewedAt: Date;
}

export interface ReviewedEvidence {
  evidenceId: string;
  caseId: string;
  status: EvidenceReviewStatus;
  reviewedByAccountId: string;
  reviewedAt: Date;
  reviewNotes: string | null;
}

// Thrown by reviewEvidence when no evidence row exists with the given id at
// all -- maps to a 404 at the service layer.
export class EvidenceNotFoundError extends Error {
  public constructor(public readonly evidenceId: string) {
    super(`No evidence exists with id ${evidenceId}`);
    this.name = "EvidenceNotFoundError";
  }
}

// Thrown by reviewEvidence when the evidence row exists but under a
// different case than the one in the URL -- a distinct condition from
// EvidenceNotFoundError above, and mapped to a 409 rather than a 404 since,
// behind staffOnly, this never needs to hide the row's existence.
export class EvidenceCaseMismatchError extends Error {
  public constructor(
    public readonly evidenceId: string,
    public readonly caseId: string,
  ) {
    super(`Evidence ${evidenceId} does not belong to case ${caseId}`);
    this.name = "EvidenceCaseMismatchError";
  }
}

export interface PublishedInformationRequest extends InformationRequestRecord {
  status: "published";
  publishedAt: Date;
  dueAt: Date;
}

export type ResubmittedCase = SubmittedCase;

export interface WithdrawnInformationRequest {
  requestId: string;
  caseId: string;
  status: "withdrawn";
  resolvedAt: Date;
  stage: "submitted";
}

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
export interface PartnerCaseDetail extends OwnedIntakeCase {
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

export interface IntakeRepository {
  getIntakeWorkflowSnapshot?(caseId: string): Promise<IntakeWorkflowSnapshot | null>;
  listIntakeCaseHistory?(input: { caseId: string; limit: number; after?: { occurredAt: Date; eventId: string } }): Promise<{ events: IntakeCaseHistoryEvent[]; hasNextPage: boolean }>;
  getIntakePrerequisites(accountId: string): Promise<IntakePrerequisites>;
  // Just the platform-setting half of getIntakePrerequisites, with no
  // accountId and no KYC read -- for the staff create-and-submit path,
  // which re-derives only the value floor and deliberately never calls
  // evaluateIntakeEntry (staff bypasses the self-KYC/proof-of-address gate).
  getMinimumPropertyValueEur(): Promise<string>;
  createDraftIntake(input: CreateDraftIntakeInput): Promise<CreatedDraftIntake>;
  // Staff-initiated equivalent of createDraftIntake + submitInitialCase
  // combined into one transaction (a case created without a revision would
  // be permanently stuck: canRecordFounderDecision and
  // evaluateInformationRequestPublication both require hasCurrentRevision).
  // Throws ApplicantAccountNotFoundError if applicantAccountId doesn't
  // resolve to a real account.
  createStaffCase(input: CreateStaffCaseInput): Promise<CreatedStaffCase>;
  listOwnedCases(input: {
    accountId: string;
    limit: number;
    after?: IntakeCaseCursor;
  }): Promise<OwnedIntakeCase[]>;
  getOwnedCase(
    accountId: string,
    caseId: string,
  ): Promise<OwnedIntakeCase | null>;
  submitInitialCase(
    input: SubmitInitialCaseInput,
  ): Promise<SubmittedCase | null>;
  listCasesForOperations(input: {
    limit: number;
    stage?: string;
    after?: IntakeCaseCursor;
  }): Promise<OwnedIntakeCase[]>;
  getCaseForOperations(caseId: string): Promise<OperationsCaseDetail | null>;
  getCasePartnerAssignment(
    caseId: string,
  ): Promise<CasePartnerAssignment | null>;
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
    after?: IntakeCaseCursor;
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
  recordLegalStructuring(
    input: RecordLegalStructuringInput,
  ): Promise<PartnerCaseDetail | null>;
  recordAppraisal(
    input: RecordAppraisalInput,
  ): Promise<PartnerCaseDetail | null>;
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
  resubmitAfterInformationRequest(
    input: SubmitInitialCaseInput & {
      requestId: string;
      submittedAt: Date;
    },
  ): Promise<ResubmittedCase | null>;
  // Targeted withdrawal of a single published information request --
  // reverts the case's stage back to "submitted" (same revision it was
  // already reviewing) rather than terminating the whole case the way
  // closeCase's "withdrawn" outcome does. Throws CaseReviewConflictError if
  // the case's stage or the request's status no longer allow this by the
  // time the FOR UPDATE-locked recheck runs, matching
  // publishInformationRequest/resubmitAfterInformationRequest above.
  // Returns null only if the case has vanished entirely since the caller's
  // own check.
  withdrawInformationRequest(input: {
    accountId: string;
    caseId: string;
    requestId: string;
    traceId: string;
    founderReviewNotes: string | null;
    withdrawnAt: Date;
  }): Promise<WithdrawnInformationRequest | null>;
  recordFounderDecision(
    input: FounderDecisionInput,
  ): Promise<RecordedFounderDecision | null>;
  closeCase(input: CloseCaseInput): Promise<ClosedCase | null>;
  // Purely advisory (nothing reads evidence status for any decision, and
  // this doesn't change that) and reviewable at any case stage, so there's
  // no accompanying policy check here the way canRecordFounderDecision
  // gates recordFounderDecision above. Throws EvidenceNotFoundError if no
  // row exists with that id at all, or EvidenceCaseMismatchError if it
  // exists under a different case than caseId.
  reviewEvidence(input: ReviewEvidenceInput): Promise<ReviewedEvidence>;
  // Ownership/existence scoping happens one level up (getOwnedCase for the
  // applicant-lane owner routes, getCaseForOperations for staff), matching
  // how every other write here separates that check from the write itself
  // — so these two operate on caseId directly, usable from either side.
  listCaseMessages(
    caseId: string,
    lane: ThreadLane,
  ): Promise<CaseMessageRecord[]>;
  postCaseMessage(input: {
    caseId: string;
    lane: ThreadLane;
    authorAccountId: string;
    body: string;
    postedAt: Date;
  }): Promise<CaseMessageRecord | null>;
  listPublishedInformationRequestsForTimers(): Promise<
    PublishedInformationRequestForTimer[]
  >;
  // Same select shape as listPublishedInformationRequestsForTimers above, but
  // scoped to one specific request (findFirst) rather than a batch findMany
  // -- used by the manual reminder/force-expire operations routes to look up
  // a single request before acting on it. Returns null both when the
  // case/request doesn't exist at all and when it exists but isn't
  // published -- callers that need to tell those apart (for 404 vs 409) do a
  // follow-up getCaseForOperations check, same as every other write below.
  getPublishedInformationRequestForTimer(
    caseId: string,
    requestId: string,
  ): Promise<PublishedInformationRequestForTimer | null>;
  expireInformationRequest(input: {
    requestId: string;
    caseId: string;
    traceId: string;
    expiredAt: Date;
    // Present only for the manual force-expire operations route; undefined
    // for the batch job's own caller (ExpireOverdueInformationRequestsService),
    // which keeps working unchanged. When present, the audit log's changes
    // payload records { manual_override: true, reason } and actorAccountId
    // instead of the batch job's system-actor (null) shape.
    manualOverride?: { reason: string; actorAccountId: string };
  }): Promise<boolean>;
  // Same method PostIpoStructuringHandoffRepository declares for the
  // pg-boss worker path (post-ipo-structuring-handoff.repository.ts) --
  // PrismaIntakeRepository already implements both interfaces with the
  // one method. Re-declared here (not just relied on via that separate
  // interface) so the HTTP-side staff retry action
  // (RetryPostIpoStructuringHandoffService, wrapping
  // TransitionCaseToPostIpoStructuringService) can call it through the same
  // IntakeRepository handle every other operations service already
  // uses, instead of threading a second repository reference through
  // app.ts.
  transitionToPostIpoStructuring(
    input: TransitionToPostIpoStructuringInput,
  ): Promise<TransitionedToPostIpoStructuring>;
  getIntakeReversalSnapshot(caseId: string): Promise<IntakeReversalSnapshot | null>;
  createReversalOperation(input: {
    caseId: string;
    command: string;
    fromStage: string;
    toStage: string;
    status: string;
    reasonCode: string;
    reason: string;
    requestedByAccountId: string;
    expectedStage: string;
    expectedWorkflowEventSequence: number;
    reversalOfEventId: string | null;
    idempotencyKey: string;
    traceId: string;
  }): Promise<IntakeReversalOperationRecord>;
  getReversalOperation(caseId: string, operationId: string): Promise<IntakeReversalOperationRecord | null>;
  approveReversalOperation(input: { caseId: string; operationId: string; approverAccountId: string; approvedAt: Date }): Promise<IntakeReversalOperationRecord | null>;
  executeReversalOperation(input: { caseId: string; operationId: string; actorAccountId: string; traceId: string; completedAt: Date }): Promise<IntakeReversalOperationRecord | null>;
}

export class CaseSubmissionConflictError extends Error {
  public constructor(public readonly currentStage: string) {
    super(`Case cannot be initially submitted from stage ${currentStage}`);
    this.name = "CaseSubmissionConflictError";
  }
}

export class ApplicantAccountNotFoundError extends Error {
  public constructor(public readonly applicantAccountId: string) {
    super(`No account exists with id ${applicantAccountId}`);
    this.name = "ApplicantAccountNotFoundError";
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
