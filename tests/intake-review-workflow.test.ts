import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type {
  CloseCaseInput,
  FounderDecisionInput,
  OperationsCaseDetail,
  IntakeRepository,
  PublishedInformationRequest,
  PublishedInformationRequestForTimer,
  ReviewedEvidence,
  ReviewEvidenceInput,
  SubmitInitialCaseInput,
  WithdrawnInformationRequest,
} from "../src/modules/intake/repository/intake.repository.js";
import {
  EvidenceCaseMismatchError,
  EvidenceNotFoundError,
} from "../src/modules/intake/repository/intake.repository.js";
import type { TransitionedToPostIpoStructuring } from "../src/modules/intake/repository/post-ipo-structuring-handoff.repository.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";

function fakeEmailSender(): EmailSender {
  return {
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    sendAccountRecoveryCaseOpenedEmail: vi.fn(),
    sendAccountRecoveryApprovedEmail: vi.fn(),
    sendAccountRecoveryRejectedEmail: vi.fn(),
    sendAccountRecoveryCompletedEmail: vi.fn(),
    sendPasskeyRecoveryEmail: vi.fn(),
  };
}

const validDocuments = [
  { document_type: "ownership_declaration", document_ref: "doc-owner", extract_dated: null },
  { document_type: "property_facts_sheet", document_ref: "doc-facts", extract_dated: null },
  { document_type: "encumbrance_declaration", document_ref: "doc-enc", extract_dated: null },
  { document_type: "photo_set", document_ref: "doc-photos", extract_dated: null },
];

const informationRequest = {
  requestId: "rfi_01",
  caseId: "case_01",
  status: "published",
  requestBody: "Please provide a newer registry extract.",
  publishedAt: new Date("2026-08-31T10:00:00.000Z"),
  dueAt: new Date("2026-09-14T10:00:00.000Z"),
  resolvedAt: null,
  resolutionType: null,
  resolvingRevisionId: null,
};

const publishedRequestForTimer: PublishedInformationRequestForTimer = {
  requestId: "rfi_01",
  caseId: "case_01",
  applicantAccountId: "acct_owner",
  applicantContactEmail: "owner@example.com",
  publishedAt: new Date("2026-08-31T10:00:00.000Z"),
  dueAt: new Date("2026-09-14T10:00:00.000Z"),
};

const operationsCase: OperationsCaseDetail = {
  caseId: "case_01",
  stage: "submitted",
  createdAt: new Date("2026-08-30T10:00:00.000Z"),
  updatedAt: new Date("2026-08-31T09:00:00.000Z"),
  currentRevision: {
    revisionNumber: 1,
    submittedAt: new Date("2026-08-31T09:00:00.000Z"),
  },
  property: {
    propertyId: "prop_01",
    propertyType: "residential",
    countryCode: "RS",
    city: "Belgrade",
    addressLine: "Example 1",
    landRegistryReference: "BG-123",
    ownerDeclaredValueEur: "175000.00",
    hasExistingEncumbrance: false,
    residentialSubtype: null,
    livingAreaSqM: null,
    bedrooms: null,
    bathrooms: null,
    floor: null,
    totalFloors: null,
    yearBuilt: null,
    condition: null,
    energyRating: null,
    rooms: [],
  },
  applicantAccountId: "acct_owner",
  legalPracticeId: null,
  appraisalFirmId: null,
  offering: null,
  founderReviewNotes: null,
  reviewedByAccountId: null,
  approvedAt: null,
  rejectedAt: null,
  rejectionReasonCode: null,
  rejectionNotes: null,
  ipoPeriodDays: null,
  ipoEndAt: null,
  ipoValueEur: null,
  submission: {
    revisionId: "rev_01",
    revisionNumber: 1,
    submittedAt: new Date("2026-08-31T09:00:00.000Z"),
    submittedByAccountId: "acct_owner",
    submissionData: { ownership: { applicant_is_owner: true } },
    evidence: [],
  },
  informationRequests: [],
};

function buildApp(options?: {
  population?: "customer" | "staff_partner";
  hasAdminRole?: boolean;
  caseRecord?: OperationsCaseDetail | null;
  ownerCaseStage?: string;
  ownedRequest?: typeof informationRequest | null;
  mfaVerified?: boolean;
  publishedRequestForTimer?: PublishedInformationRequestForTimer | null;
  expireInformationRequestResult?: boolean;
}) {
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue({
      betterAuthUserId: "auth_actor",
      providerSessionId: "session_actor",
      population: options?.population ?? "staff_partner",
    }),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({
      accountId: options?.population === "customer" ? "acct_owner" : "acct_founder",
      status: "active",
    }),
    findByEmail: vi.fn(),
    hasActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
  };
  const publishInformationRequest = vi.fn(async (input): Promise<PublishedInformationRequest> => ({
    ...informationRequest,
    requestBody: input.requestBody,
    publishedAt: input.publishedAt,
    dueAt: input.dueAt,
    status: "published",
  }));
  const recordFounderDecision = vi.fn(async (input: FounderDecisionInput) => ({
    caseId: input.caseId,
    stage: input.decision === "approve" ? "pre_offering_open" as const : "rejected" as const,
    decidedAt: input.decidedAt,
    ipoEndAt: input.decision === "approve" ? input.ipoEndAt : null,
  }));
  const resubmitAfterInformationRequest = vi.fn(async (input: SubmitInitialCaseInput) => ({
    caseId: input.caseId,
    revisionId: "rev_02",
    revisionNumber: 2,
    stage: "submitted" as const,
    submittedAt: new Date("2026-09-01T12:00:00.000Z"),
  }));
  const closeCase = vi.fn(async (input: CloseCaseInput) => ({
    caseId: input.caseId,
    stage: input.outcome,
    closedAt: input.closedAt,
  }));
  const transitionToPostIpoStructuring = vi.fn(
    async (input: { caseId: string }): Promise<TransitionedToPostIpoStructuring> => ({
      caseId: input.caseId,
      stage: "post_ipo_structuring",
    }),
  );
  const reviewEvidence = vi.fn(
    async (input: ReviewEvidenceInput): Promise<ReviewedEvidence> => ({
      evidenceId: input.evidenceId,
      caseId: input.caseId,
      status: input.status,
      reviewedByAccountId: input.accountId,
      reviewedAt: input.reviewedAt,
      reviewNotes: input.reviewNotes,
    }),
  );
  const withdrawInformationRequest = vi.fn(
    async (input: {
      caseId: string;
      requestId: string;
      withdrawnAt: Date;
    }): Promise<WithdrawnInformationRequest> => ({
      requestId: input.requestId,
      caseId: input.caseId,
      status: "withdrawn",
      resolvedAt: input.withdrawnAt,
      stage: "submitted",
    }),
  );
  const listCaseMessages = vi.fn().mockResolvedValue([
    {
      messageId: "msg_01",
      authorAccountId: "acct_founder",
      body: "Requesting an updated registry extract.",
      createdAt: new Date("2026-09-01T10:00:00.000Z"),
    },
  ]);
  const postCaseMessage = vi.fn(
    async (input: { caseId: string; lane: string; authorAccountId: string; body: string; postedAt: Date }) => ({
      messageId: "msg_02",
      authorAccountId: input.authorAccountId,
      body: input.body,
      createdAt: input.postedAt,
    }),
  );
  const ownerCase = {
    ...operationsCase,
    stage: options?.ownerCaseStage ?? "waiting_on_applicant",
    informationRequests: undefined,
    submission: undefined,
  };
  const emailSender = fakeEmailSender();
  const getPublishedInformationRequestForTimer = vi.fn().mockResolvedValue(
    options !== undefined && "publishedRequestForTimer" in options
      ? options.publishedRequestForTimer
      : publishedRequestForTimer,
  );
  const expireInformationRequest = vi
    .fn()
    .mockResolvedValue(options?.expireInformationRequestResult ?? true);
  const repository: IntakeRepository = {
    getIntakePrerequisites: vi.fn().mockResolvedValue({
      eligibilityState: "eligible",
      proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
      minimumPropertyValueEur: "150000.00",
    }),
    createDraftIntake: vi.fn(),
    getMinimumPropertyValueEur: vi.fn(),
    createStaffCase: vi.fn(),
    listOwnedCases: vi.fn().mockResolvedValue([]),
    getOwnedCase: vi.fn().mockResolvedValue(ownerCase),
    submitInitialCase: vi.fn().mockResolvedValue(null),
    listCasesForOperations: vi.fn().mockResolvedValue([operationsCase]),
    getCaseForOperations: vi.fn().mockResolvedValue(
      options !== undefined && "caseRecord" in options ? options.caseRecord : operationsCase,
    ),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    transitionToPostIpoStructuring,
    publishInformationRequest,
    getOwnedInformationRequest: vi.fn().mockResolvedValue(
      options !== undefined && "ownedRequest" in options
        ? options.ownedRequest
        : informationRequest,
    ),
    listOwnedInformationRequests: vi.fn().mockResolvedValue([informationRequest]),
    resubmitAfterInformationRequest,
    recordFounderDecision,
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    getPublishedInformationRequestForTimer,
    expireInformationRequest,
    withdrawInformationRequest,
    closeCase,
    reviewEvidence,
    listCaseMessages,
    postCaseMessage,
    getCasePartnerAssignment: vi.fn().mockResolvedValue(null),
    assignPartnerOrganization: vi.fn().mockResolvedValue(null),
    listCasesForPartner: vi.fn().mockResolvedValue([]),
    getCaseForPartner: vi.fn().mockResolvedValue(null),
    recordLegalStructuring: vi.fn().mockResolvedValue(null),
    recordAppraisal: vi.fn().mockResolvedValue(null),
  };

  return {
    app: createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      corsOrigins: [],
      protectedApi: {
        accounts,
        sessions,
        intakeRepository: repository,
        emailSender,
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(options?.mfaVerified ?? true),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
      },
    }),
    accounts,
    publishInformationRequest,
    recordFounderDecision,
    resubmitAfterInformationRequest,
    closeCase,
    transitionToPostIpoStructuring,
    reviewEvidence,
    withdrawInformationRequest,
    listCaseMessages,
    postCaseMessage,
    emailSender,
    expireInformationRequest,
    getPublishedInformationRequestForTimer,
  };
}

describe("founder review and information requests", () => {
  it("denies the internal surface to a customer even if a role lookup would pass", async () => {
    const { app, accounts } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).get("/internal/v1/intake-cases");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
    expect(accounts.hasActiveStaffRole).not.toHaveBeenCalled();
  });

  it("denies staff without an active admin operations assignment", async () => {
    const { app } = buildApp({ hasAdminRole: false });

    const response = await request(app).get("/internal/v1/intake-cases");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies an authorized founder until WebAuthn is verified for the session", async () => {
    const { app } = buildApp({ mfaVerified: false });

    const response = await request(app).get("/internal/v1/intake-cases");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_mfa_required");
  });

  it("returns the current submission package to authorized operations staff", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/intake-cases/case_01");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      case_id: "case_01",
      applicant_account_id: "acct_owner",
      legal_practice_id: null,
      appraisal_firm_id: null,
      offering: null,
      submission: { revision_id: "rev_01", revision_number: 1 },
    });
  });

  it("surfaces the case's linked offering, including a stuck pre_offering_open handoff signal", async () => {
    const { app } = buildApp({
      caseRecord: {
        ...operationsCase,
        stage: "pre_offering_open",
        offering: {
          offeringId: "offering_01",
          status: "pre_offering",
          finalOfferingPublishedAt: new Date("2026-09-05T10:00:00.000Z"),
        },
      },
    });

    const response = await request(app).get("/internal/v1/intake-cases/case_01");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      stage: "pre_offering_open",
      offering: {
        offering_id: "offering_01",
        status: "pre_offering",
        final_offering_published_at: "2026-09-05T10:00:00.000Z",
      },
    });
  });

  it("surfaces the case's currently assigned legal practice and appraisal firm on page load", async () => {
    const { app } = buildApp({
      caseRecord: {
        ...operationsCase,
        legalPracticeId: "practice_01",
        appraisalFirmId: "firm_01",
      },
    });

    const response = await request(app).get("/internal/v1/intake-cases/case_01");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      legal_practice_id: "practice_01",
      appraisal_firm_id: "firm_01",
    });
  });

  it("publishes an applicant request and returns its configured business-day deadline", async () => {
    const { app, publishInformationRequest } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests")
      .send({ request_body: "Please provide a newer registry extract." });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      request_id: "rfi_01",
      status: "published",
      request_body: "Please provide a newer registry extract.",
    });
    expect(publishInformationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_founder", caseId: "case_01" }),
    );
  });

  it("records founder approval and its IPO terms in one command", async () => {
    const { app, recordFounderDecision } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/decisions")
      .send({
        decision: "approve",
        founder_review_notes: "Ownership package is sufficient.",
        ipo_period_days: 30,
        ipo_value_eur: "25000.00",
      });

    expect(response.status).toBe(200);
    expect(response.body.data.stage).toBe("pre_offering_open");
    expect(recordFounderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "approve",
        accountId: "acct_founder",
        ipoPeriodDays: 30,
        ipoValueEur: "25000.00",
      }),
    );
  });

  it("records a rejection with a structured reason", async () => {
    const { app, recordFounderDecision } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/decisions")
      .send({
        decision: "reject",
        founder_review_notes: "Ownership claim could not be supported.",
        rejection_reason_code: "ownership_unverified",
        rejection_notes: "Submitted documents conflict with the registry record.",
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ stage: "rejected", ipo_end_at: null });
    expect(recordFounderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "reject",
        rejectionReasonCode: "ownership_unverified",
      }),
    );
  });

  it("rejects a zero-value approval before repository work", async () => {
    const { app, recordFounderDecision } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/decisions")
      .send({
        decision: "approve",
        founder_review_notes: "Invalid terms.",
        ipo_period_days: 30,
        ipo_value_eur: "0.00",
      });

    expect(response.status).toBe(422);
    expect(recordFounderDecision).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric ipo_value_eur with a clean 422, not a crash", async () => {
    const { app, recordFounderDecision } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/decisions")
      .send({
        decision: "approve",
        founder_review_notes: "Invalid terms.",
        ipo_period_days: 30,
        ipo_value_eur: "not-a-number",
      });

    expect(response.status).toBe(422);
    expect(recordFounderDecision).not.toHaveBeenCalled();
  });

  it("lets the owner list published requests", async () => {
    const { app } = buildApp({ population: "customer" });

    const response = await request(app).get(
      "/v1/intake-cases/case_01/information-requests",
    );

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      request_id: "rfi_01",
      case_id: "case_01",
      status: "published",
    });
  });

  it("creates revision 2 when the owner answers the current request", async () => {
    const { app, resubmitAfterInformationRequest } = buildApp({ population: "customer" });

    const response = await request(app)
      .post("/v1/intake-cases/case_01/information-requests/rfi_01/respond")
      .send({
        intake_terms_accepted: true,
        one_title_confirmed: true,
        submission_data: { ownership: { applicant_is_owner: true }, update: "new extract" },
        documents: validDocuments,
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      case_id: "case_01",
      revision_id: "rev_02",
      revision_number: 2,
      stage: "submitted",
      resolved_request_id: "rfi_01",
    });
    expect(resubmitAfterInformationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_owner",
        requestId: "rfi_01",
        submissionData: expect.objectContaining({
          response_to_information_request_id: "rfi_01",
        }),
      }),
    );
  });

  it("hides an information request outside the owner's scope", async () => {
    const { app, resubmitAfterInformationRequest } = buildApp({
      population: "customer",
      ownedRequest: null,
    });

    const response = await request(app)
      .post("/v1/intake-cases/case_01/information-requests/rfi_other/respond")
      .send({
        intake_terms_accepted: true,
        one_title_confirmed: true,
        submission_data: { update: true },
        documents: validDocuments,
      });

    expect(response.status).toBe(404);
    expect(resubmitAfterInformationRequest).not.toHaveBeenCalled();
  });
});

describe("closing a case (withdraw or late-stage reject)", () => {
  it("denies the internal surface to a customer", async () => {
    const { app, closeCase } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/close")
      .send({ outcome: "withdrawn", founder_review_notes: "Applicant emailed to withdraw." });

    expect(response.status).toBe(403);
    expect(closeCase).not.toHaveBeenCalled();
  });

  it("withdraws a case from the submitted stage on the applicant's behalf", async () => {
    const { app, closeCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/close")
      .send({ outcome: "withdrawn", founder_review_notes: "Applicant emailed to withdraw." });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ case_id: "case_01", stage: "withdrawn" });
    expect(closeCase).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "withdrawn",
        caseId: "case_01",
        accountId: "acct_founder",
        founderReviewNotes: "Applicant emailed to withdraw.",
      }),
    );
  });

  it("rejects a case that reached pre-offering open but ended up underfunded", async () => {
    const { app, closeCase } = buildApp({
      caseRecord: { ...operationsCase, stage: "pre_offering_open" },
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/close")
      .send({
        outcome: "rejected",
        founder_review_notes: "IPO period ended underfunded.",
        rejection_reason_code: "IPO_PERIOD_UNDERFUNDED",
        rejection_notes: "Only 40% of ipo_value_eur collected by ipo_end_at.",
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ case_id: "case_01", stage: "rejected" });
    expect(closeCase).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "rejected",
        rejectionReasonCode: "IPO_PERIOD_UNDERFUNDED",
      }),
    );
  });

  it("refuses to withdraw or reject a case that has already reached a terminal stage", async () => {
    const { app, closeCase } = buildApp({
      caseRecord: { ...operationsCase, stage: "rejected" },
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/close")
      .send({ outcome: "withdrawn", founder_review_notes: "Too late." });

    expect(response.status).toBe(409);
    expect(closeCase).not.toHaveBeenCalled();
  });

  it("refuses a late-stage reject from a stage the lifecycle diagram doesn't allow it from", async () => {
    const { app, closeCase } = buildApp({
      caseRecord: { ...operationsCase, stage: "waiting_on_applicant" },
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/close")
      .send({
        outcome: "rejected",
        founder_review_notes: "Trying to reject too early.",
        rejection_reason_code: "TEST",
        rejection_notes: "TEST",
      });

    expect(response.status).toBe(409);
    expect(closeCase).not.toHaveBeenCalled();
  });
});

describe("manual retry of the post-IPO structuring handoff", () => {
  it("denies the internal surface to a customer", async () => {
    const { app, transitionToPostIpoStructuring } = buildApp({
      population: "customer",
      hasAdminRole: true,
    });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_01/retry-post-ipo-handoff",
    );

    expect(response.status).toBe(403);
    expect(transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });

  it("404s for a case that doesn't exist", async () => {
    const { app, transitionToPostIpoStructuring } = buildApp({ caseRecord: null });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_missing/retry-post-ipo-handoff",
    );

    expect(response.status).toBe(404);
    expect(transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });

  it("refuses to retry a case with no linked offering yet", async () => {
    const { app, transitionToPostIpoStructuring } = buildApp({
      caseRecord: { ...operationsCase, stage: "pre_offering_open", offering: null },
    });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_01/retry-post-ipo-handoff",
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("intake.post_ipo_handoff_not_ready");
    expect(transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });

  it("refuses to retry a case whose offering hasn't reached final_offering_published_at", async () => {
    const { app, transitionToPostIpoStructuring } = buildApp({
      caseRecord: {
        ...operationsCase,
        stage: "pre_offering_open",
        offering: {
          offeringId: "offering_01",
          status: "pre_offering",
          finalOfferingPublishedAt: null,
        },
      },
    });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_01/retry-post-ipo-handoff",
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("intake.post_ipo_handoff_not_ready");
    expect(transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });

  it("retries the handoff once the same automatic trigger condition is met", async () => {
    const { app, transitionToPostIpoStructuring } = buildApp({
      caseRecord: {
        ...operationsCase,
        stage: "pre_offering_open",
        offering: {
          offeringId: "offering_01",
          status: "pre_offering",
          finalOfferingPublishedAt: new Date("2026-09-05T10:00:00.000Z"),
        },
      },
    });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_01/retry-post-ipo-handoff",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ case_id: "case_01", stage: "post_ipo_structuring" });
    expect(transitionToPostIpoStructuring).toHaveBeenCalledWith({
      caseId: "case_01",
      traceId: expect.any(String),
      transitionedAt: expect.any(Date),
    });
  });

  it("surfaces the existing transition service's own safe no-op when the case already advanced", async () => {
    const { app, transitionToPostIpoStructuring } = buildApp({
      caseRecord: {
        ...operationsCase,
        stage: "approved_for_final_offering",
        offering: {
          offeringId: "offering_01",
          status: "final_offering",
          finalOfferingPublishedAt: new Date("2026-09-05T10:00:00.000Z"),
        },
      },
    });
    transitionToPostIpoStructuring.mockResolvedValueOnce({
      caseId: "case_01",
      stage: "approved_for_final_offering",
    });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_01/retry-post-ipo-handoff",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      case_id: "case_01",
      stage: "approved_for_final_offering",
    });
  });
});

describe("reviewing a submitted evidence document (PUT, full-replace)", () => {
  it("denies the internal surface to a customer", async () => {
    const { app, reviewEvidence } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "accepted", review_notes: null });

    expect(response.status).toBe(403);
    expect(reviewEvidence).not.toHaveBeenCalled();
  });

  it("denies staff without an active admin operations assignment", async () => {
    const { app, reviewEvidence } = buildApp({ hasAdminRole: false });

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "accepted", review_notes: null });

    expect(response.status).toBe(403);
    expect(reviewEvidence).not.toHaveBeenCalled();
  });

  it("accepts evidence with an explicit review note", async () => {
    const { app, reviewEvidence } = buildApp();

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "accepted", review_notes: "Registry extract matches the declared owner." });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      evidence_id: "ev_01",
      case_id: "case_01",
      status: "accepted",
      reviewed_by_account_id: "acct_founder",
      review_notes: "Registry extract matches the declared owner.",
    });
    expect(reviewEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_founder",
        caseId: "case_01",
        evidenceId: "ev_01",
        status: "accepted",
        reviewNotes: "Registry extract matches the declared owner.",
      }),
    );
  });

  // Asserts PUT's full-replace semantics, not just a default: reviewNotes
  // reaches the repository as an explicit null rather than being omitted,
  // so a later re-review can't silently keep an old note around (the
  // repository writes all four review fields unconditionally on every
  // call for exactly this reason).
  it("accepts evidence with no review note (defaults to null)", async () => {
    const { app, reviewEvidence } = buildApp();

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "accepted" });

    expect(response.status).toBe(200);
    expect(response.body.data.review_notes).toBeNull();
    expect(reviewEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ status: "accepted", reviewNotes: null }),
    );
  });

  it("rejects evidence given a review note", async () => {
    const { app, reviewEvidence } = buildApp();

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "rejected", review_notes: "Document is illegible." });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("rejected");
    expect(reviewEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected", reviewNotes: "Document is illegible." }),
    );
  });

  it("422s a rejection missing its required review note", async () => {
    const { app, reviewEvidence } = buildApp();

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "rejected" });

    expect(response.status).toBe(422);
    expect(reviewEvidence).not.toHaveBeenCalled();
  });

  it("marks evidence mandatory_missing given a review note", async () => {
    const { app, reviewEvidence } = buildApp();

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "mandatory_missing", review_notes: "Applicant never uploaded this document." });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("mandatory_missing");
  });

  it("422s a mandatory_missing status missing its required review note", async () => {
    const { app, reviewEvidence } = buildApp();

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "mandatory_missing" });

    expect(response.status).toBe(422);
    expect(reviewEvidence).not.toHaveBeenCalled();
  });

  it("422s an unrecognized status value", async () => {
    const { app, reviewEvidence } = buildApp();

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_01/review")
      .send({ status: "pending" });

    expect(response.status).toBe(422);
    expect(reviewEvidence).not.toHaveBeenCalled();
  });

  it("404s reviewing evidence that doesn't exist", async () => {
    const { app, reviewEvidence } = buildApp();
    reviewEvidence.mockRejectedValueOnce(new EvidenceNotFoundError("ev_missing"));

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_missing/review")
      .send({ status: "accepted", review_notes: null });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("intake.evidence_not_found");
  });

  it("409s reviewing evidence that belongs to a different case", async () => {
    const { app, reviewEvidence } = buildApp();
    reviewEvidence.mockRejectedValueOnce(new EvidenceCaseMismatchError("ev_other", "case_01"));

    const response = await request(app)
      .put("/internal/v1/intake-cases/case_01/evidence/ev_other/review")
      .send({ status: "accepted", review_notes: null });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("intake.evidence_case_mismatch");
  });
});

describe("withdrawing a published information request", () => {
  const waitingCaseWithPublishedRequest: OperationsCaseDetail = {
    ...operationsCase,
    stage: "waiting_on_applicant",
    informationRequests: [informationRequest],
  };

  it("denies the internal surface to a customer", async () => {
    const { app, withdrawInformationRequest } = buildApp({
      population: "customer",
      hasAdminRole: true,
      caseRecord: waitingCaseWithPublishedRequest,
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/withdraw")
      .send({ founder_review_notes: "Published in error." });

    expect(response.status).toBe(403);
    expect(withdrawInformationRequest).not.toHaveBeenCalled();
  });

  it("withdraws a published request and reverts the case back to submitted", async () => {
    const { app, withdrawInformationRequest } = buildApp({
      caseRecord: waitingCaseWithPublishedRequest,
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/withdraw")
      .send({ founder_review_notes: "Published in error." });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      request_id: "rfi_01",
      case_id: "case_01",
      status: "withdrawn",
      stage: "submitted",
    });
    expect(withdrawInformationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_founder",
        caseId: "case_01",
        requestId: "rfi_01",
        founderReviewNotes: "Published in error.",
      }),
    );
  });

  it("defaults founder_review_notes to null when omitted", async () => {
    const { app, withdrawInformationRequest } = buildApp({
      caseRecord: waitingCaseWithPublishedRequest,
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/withdraw")
      .send({});

    expect(response.status).toBe(200);
    expect(withdrawInformationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ founderReviewNotes: null }),
    );
  });

  it("refuses to withdraw when the case stage isn't waiting_on_applicant", async () => {
    const { app, withdrawInformationRequest } = buildApp({
      caseRecord: { ...waitingCaseWithPublishedRequest, stage: "submitted" },
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/withdraw")
      .send({ founder_review_notes: "Too early." });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("intake.review_transition_conflict");
    expect(withdrawInformationRequest).not.toHaveBeenCalled();
  });

  it("refuses to withdraw a request that isn't currently published", async () => {
    const { app, withdrawInformationRequest } = buildApp({
      caseRecord: {
        ...waitingCaseWithPublishedRequest,
        informationRequests: [{ ...informationRequest, status: "answered" }],
      },
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/withdraw")
      .send({ founder_review_notes: "Already answered." });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("intake.review_transition_conflict");
    expect(withdrawInformationRequest).not.toHaveBeenCalled();
  });

  it("404s for a request id that doesn't belong to the case", async () => {
    const { app, withdrawInformationRequest } = buildApp({
      caseRecord: waitingCaseWithPublishedRequest,
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_missing/withdraw")
      .send({ founder_review_notes: "Nope." });

    expect(response.status).toBe(404);
    expect(withdrawInformationRequest).not.toHaveBeenCalled();
  });
});

describe("operations case messages (internal_case and applicant lanes)", () => {
  it("denies the internal surface to a customer", async () => {
    const { app, listCaseMessages } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).get(
      "/internal/v1/intake-cases/case_01/messages?lane=internal_case",
    );

    expect(response.status).toBe(403);
    expect(listCaseMessages).not.toHaveBeenCalled();
  });

  it("reads the internal_case lane, which the founder is the only participant in", async () => {
    const { app, listCaseMessages } = buildApp();

    const response = await request(app).get(
      "/internal/v1/intake-cases/case_01/messages?lane=internal_case",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ message_id: "msg_01", body: "Requesting an updated registry extract." }),
    ]);
    expect(listCaseMessages).toHaveBeenCalledWith("case_01", "internal_case");
  });

  it("reads the applicant lane too", async () => {
    const { app, listCaseMessages } = buildApp();

    const response = await request(app).get(
      "/internal/v1/intake-cases/case_01/messages?lane=applicant",
    );

    expect(response.status).toBe(200);
    expect(listCaseMessages).toHaveBeenCalledWith("case_01", "applicant");
  });

  it("rejects a lane query outside the fixed lane set", async () => {
    const { app } = buildApp();

    const response = await request(app).get(
      "/internal/v1/intake-cases/case_01/messages?lane=legal_workstream",
    );

    expect(response.status).toBe(422);
  });

  it("posts to either lane as the founder", async () => {
    const { app, postCaseMessage } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/messages")
      .send({ lane: "internal_case", body: "Ownership evidence looks solid, proceeding to review." });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      body: "Ownership evidence looks solid, proceeding to review.",
    });
    expect(postCaseMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: "case_01",
        lane: "internal_case",
        authorAccountId: "acct_founder",
        body: "Ownership evidence looks solid, proceeding to review.",
      }),
    );
  });

  it("404s posting to a case that doesn't exist", async () => {
    const { app, postCaseMessage } = buildApp({ caseRecord: null });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_missing/messages")
      .send({ lane: "applicant", body: "Hello" });

    expect(response.status).toBe(404);
    expect(postCaseMessage).not.toHaveBeenCalled();
  });
});

describe("manual reminder and force-expire for a single information request", () => {
  it("denies the internal surface to a customer for send-reminder", async () => {
    const { app, emailSender } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_01/information-requests/rfi_01/send-reminder",
    );

    expect(response.status).toBe(403);
    expect(emailSender.sendApplicantResponseReminderEmail).not.toHaveBeenCalled();
  });

  it("denies the internal surface to a customer for force-expire", async () => {
    const { app, expireInformationRequest } = buildApp({
      population: "customer",
      hasAdminRole: true,
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/force-expire")
      .send({ reason: "Applicant unresponsive after repeated outreach." });

    expect(response.status).toBe(403);
    expect(expireInformationRequest).not.toHaveBeenCalled();
  });

  it("sends a reminder immediately even though the normal reminder-milestone gate wouldn't have fired yet", async () => {
    // publishedAt is "today" for the fixture's default clock-independent fixed
    // date, so isApplicantReminderDue (business-day milestones) would not be
    // due -- SendManualReminderService deliberately never calls that gate.
    const { app, emailSender } = buildApp({
      publishedRequestForTimer: {
        ...publishedRequestForTimer,
        publishedAt: new Date(),
        dueAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_01/information-requests/rfi_01/send-reminder",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      request_id: "rfi_01",
      case_id: "case_01",
      sent: true,
    });
    expect(emailSender.sendApplicantResponseReminderEmail).toHaveBeenCalledWith({
      to: "owner@example.com",
      dueAt: new Date("2099-01-01T00:00:00.000Z"),
    });
  });

  it("force-expires a published request with a typed reason, recorded as a manual override", async () => {
    const { app, expireInformationRequest } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/force-expire")
      .send({ reason: "Applicant unresponsive after repeated outreach." });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      request_id: "rfi_01",
      case_id: "case_01",
      status: "expired",
    });
    expect(expireInformationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "rfi_01",
        caseId: "case_01",
        manualOverride: {
          reason: "Applicant unresponsive after repeated outreach.",
          actorAccountId: "acct_founder",
        },
      }),
    );
  });

  it("rejects an empty reason before any repository work", async () => {
    const { app, expireInformationRequest } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/force-expire")
      .send({ reason: "" });

    expect(response.status).toBe(422);
    expect(expireInformationRequest).not.toHaveBeenCalled();
  });

  it("returns 409 when the request is no longer published (precondition not met)", async () => {
    const { app, expireInformationRequest } = buildApp({
      publishedRequestForTimer: null,
      caseRecord: {
        ...operationsCase,
        informationRequests: [{ ...informationRequest, status: "answered" }],
      },
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_01/force-expire")
      .send({ reason: "Trying to expire an already-answered request." });

    expect(response.status).toBe(409);
    expect(expireInformationRequest).not.toHaveBeenCalled();
  });

  it("404s force-expire for a request that doesn't exist on a real case", async () => {
    const { app, expireInformationRequest } = buildApp({
      publishedRequestForTimer: null,
      caseRecord: { ...operationsCase, informationRequests: [] },
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/information-requests/rfi_missing/force-expire")
      .send({ reason: "Never existed." });

    expect(response.status).toBe(404);
    expect(expireInformationRequest).not.toHaveBeenCalled();
  });

  it("404s force-expire for a case that doesn't exist", async () => {
    const { app, expireInformationRequest } = buildApp({
      publishedRequestForTimer: null,
      caseRecord: null,
    });

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_missing/information-requests/rfi_01/force-expire")
      .send({ reason: "Case is gone." });

    expect(response.status).toBe(404);
    expect(expireInformationRequest).not.toHaveBeenCalled();
  });

  it("404s send-reminder for a case that doesn't exist", async () => {
    const { app, emailSender } = buildApp({
      publishedRequestForTimer: null,
      caseRecord: null,
    });

    const response = await request(app).post(
      "/internal/v1/intake-cases/case_missing/information-requests/rfi_01/send-reminder",
    );

    expect(response.status).toBe(404);
    expect(emailSender.sendApplicantResponseReminderEmail).not.toHaveBeenCalled();
  });
});

function fakeStaffWebAuthnRepository(verified: boolean) {
  return {
    listCredentials: vi.fn().mockResolvedValue([]),
    findCredential: vi.fn().mockResolvedValue(null),
    isSessionVerified: vi.fn().mockResolvedValue(verified),
    replaceChallenge: vi.fn(),
    getActiveChallenge: vi.fn().mockResolvedValue(null),
    failChallenge: vi.fn().mockResolvedValue(false),
    completeRegistration: vi.fn().mockResolvedValue(false),
    completeAuthentication: vi.fn().mockResolvedValue(false),
  };
}

function fakeStaffWebAuthnCeremony() {
  return {
    generateRegistrationOptions: vi.fn(),
    verifyRegistration: vi.fn(),
    generateAuthenticationOptions: vi.fn(),
    verifyAuthentication: vi.fn(),
  };
}
