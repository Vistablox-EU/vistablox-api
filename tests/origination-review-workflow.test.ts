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
  OriginationRepository,
  PublishedInformationRequest,
  SubmitInitialCaseInput,
} from "../src/modules/origination/repository/origination.repository.js";

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
  },
  applicantAccountId: "acct_owner",
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
    hasActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
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
  const ownerCase = {
    ...operationsCase,
    stage: options?.ownerCaseStage ?? "waiting_on_applicant",
    informationRequests: undefined,
    submission: undefined,
  };
  const repository: OriginationRepository = {
    getIntakePrerequisites: vi.fn().mockResolvedValue({
      eligibilityState: "eligible",
      proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
      minimumPropertyValueEur: "150000.00",
    }),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn().mockResolvedValue([]),
    getOwnedCase: vi.fn().mockResolvedValue(ownerCase),
    submitInitialCase: vi.fn().mockResolvedValue(null),
    listCasesForOperations: vi.fn().mockResolvedValue([operationsCase]),
    getCaseForOperations: vi.fn().mockResolvedValue(
      options !== undefined && "caseRecord" in options ? options.caseRecord : operationsCase,
    ),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
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
    expireInformationRequest: vi.fn().mockResolvedValue(false),
    closeCase,
  };

  return {
    app: createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: {
        listPublic: vi.fn().mockResolvedValue([]),
        getInvestorDetail: vi.fn().mockResolvedValue(null),
      },
      logger: pino({ level: "silent" }),
      protectedApi: {
        accounts,
        sessions,
        originationRepository: repository,
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(options?.mfaVerified ?? true),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
      },
    }),
    accounts,
    publishInformationRequest,
    recordFounderDecision,
    resubmitAfterInformationRequest,
    closeCase,
  };
}

describe("founder review and information requests", () => {
  it("denies the internal surface to a customer even if a role lookup would pass", async () => {
    const { app, accounts } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).get("/internal/v1/origination-cases");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
    expect(accounts.hasActiveStaffRole).not.toHaveBeenCalled();
  });

  it("denies staff without an active admin operations assignment", async () => {
    const { app } = buildApp({ hasAdminRole: false });

    const response = await request(app).get("/internal/v1/origination-cases");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies an authorized founder until WebAuthn is verified for the session", async () => {
    const { app } = buildApp({ mfaVerified: false });

    const response = await request(app).get("/internal/v1/origination-cases");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_mfa_required");
  });

  it("returns the current submission package to authorized operations staff", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/origination-cases/case_01");

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      case_id: "case_01",
      applicant_account_id: "acct_owner",
      submission: { revision_id: "rev_01", revision_number: 1 },
    });
  });

  it("publishes an applicant request and returns its configured business-day deadline", async () => {
    const { app, publishInformationRequest } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/information-requests")
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
      .post("/internal/v1/origination-cases/case_01/decisions")
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
      .post("/internal/v1/origination-cases/case_01/decisions")
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
      .post("/internal/v1/origination-cases/case_01/decisions")
      .send({
        decision: "approve",
        founder_review_notes: "Invalid terms.",
        ipo_period_days: 30,
        ipo_value_eur: "0.00",
      });

    expect(response.status).toBe(422);
    expect(recordFounderDecision).not.toHaveBeenCalled();
  });

  it("lets the owner list published requests", async () => {
    const { app } = buildApp({ population: "customer" });

    const response = await request(app).get(
      "/v1/origination-cases/case_01/information-requests",
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
      .post("/v1/origination-cases/case_01/information-requests/rfi_01/respond")
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
      .post("/v1/origination-cases/case_01/information-requests/rfi_other/respond")
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
      .post("/internal/v1/origination-cases/case_01/close")
      .send({ outcome: "withdrawn", founder_review_notes: "Applicant emailed to withdraw." });

    expect(response.status).toBe(403);
    expect(closeCase).not.toHaveBeenCalled();
  });

  it("withdraws a case from the submitted stage on the applicant's behalf", async () => {
    const { app, closeCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/close")
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
      .post("/internal/v1/origination-cases/case_01/close")
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
      .post("/internal/v1/origination-cases/case_01/close")
      .send({ outcome: "withdrawn", founder_review_notes: "Too late." });

    expect(response.status).toBe(409);
    expect(closeCase).not.toHaveBeenCalled();
  });

  it("refuses a late-stage reject from a stage the lifecycle diagram doesn't allow it from", async () => {
    const { app, closeCase } = buildApp({
      caseRecord: { ...operationsCase, stage: "waiting_on_applicant" },
    });

    const response = await request(app)
      .post("/internal/v1/origination-cases/case_01/close")
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
