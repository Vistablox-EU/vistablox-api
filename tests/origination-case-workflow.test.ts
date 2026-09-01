import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import {
  CaseSubmissionConflictError,
  type OriginationRepository,
  type OwnedOriginationCase,
  type SubmitInitialCaseInput,
} from "../src/modules/origination/repository/origination.repository.js";

const ownedCase: OwnedOriginationCase = {
  caseId: "case_01",
  stage: "draft",
  createdAt: new Date("2026-08-31T10:00:00.000Z"),
  updatedAt: new Date("2026-08-31T10:00:00.000Z"),
  currentRevision: null,
  property: {
    propertyId: "prop_01",
    propertyType: "residential",
    countryCode: "RS",
    city: "Belgrade",
    addressLine: "Example 1",
    landRegistryReference: "BG-123",
    ownerDeclaredValueEur: "150000.00",
    hasExistingEncumbrance: false,
  },
};

const validSubmissionBody = {
  intake_terms_accepted: true,
  one_title_confirmed: true,
  submission_data: {
    ownership: { ownership_type: "sole_natural_person", applicant_is_owner: true },
    occupancy: { occupied: false },
  },
  documents: [
    { document_type: "ownership_declaration", document_ref: "doc_owner", extract_dated: null },
    { document_type: "property_facts_sheet", document_ref: "doc_facts", extract_dated: null },
    { document_type: "encumbrance_declaration", document_ref: "doc_enc", extract_dated: null },
    { document_type: "photo_set", document_ref: "doc_photos", extract_dated: null },
  ],
};

function buildApp(options?: {
  caseRecord?: OwnedOriginationCase | null;
  listRows?: OwnedOriginationCase[];
  submissionConflict?: boolean;
  eligibilityState?: string;
  caseMessages?: Array<{
    messageId: string;
    authorAccountId: string | null;
    body: string;
    createdAt: Date;
  }>;
}) {
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue({
      betterAuthUserId: "auth_user_01",
      providerSessionId: "session_01",
      population: "customer",
    }),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_01", status: "active" }),
    hasActiveStaffRole: vi.fn().mockResolvedValue(false),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(false),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
  };
  const submitInitialCase = vi.fn(async (_input: SubmitInitialCaseInput) => {
    if (options?.submissionConflict === true) throw new CaseSubmissionConflictError("submitted");
    return {
      caseId: "case_01",
      revisionId: "rev_01",
      revisionNumber: 1 as const,
      stage: "submitted" as const,
      submittedAt: new Date("2026-08-31T11:00:00.000Z"),
    };
  });
  const listCaseMessages = vi.fn(async () => options?.caseMessages ?? []);
  const postCaseMessage = vi.fn(
    async (input: { caseId: string; lane: string; authorAccountId: string; body: string; postedAt: Date }) => ({
      messageId: "msg_posted",
      authorAccountId: input.authorAccountId,
      body: input.body,
      createdAt: input.postedAt,
    }),
  );
  const repository: OriginationRepository = {
    getIntakePrerequisites: vi.fn().mockResolvedValue({
      eligibilityState: options?.eligibilityState ?? "eligible",
      proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
      minimumPropertyValueEur: "150000.00",
    }),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn().mockResolvedValue(options?.listRows ?? [ownedCase]),
    getOwnedCase: vi.fn().mockResolvedValue(
      options !== undefined && "caseRecord" in options ? options.caseRecord : ownedCase,
    ),
    submitInitialCase,
    listCasesForOperations: vi.fn().mockResolvedValue([]),
    getCaseForOperations: vi.fn().mockResolvedValue(null),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    publishInformationRequest: vi.fn().mockResolvedValue(null),
    getOwnedInformationRequest: vi.fn().mockResolvedValue(null),
    listOwnedInformationRequests: vi.fn().mockResolvedValue([]),
    resubmitAfterInformationRequest: vi.fn().mockResolvedValue(null),
    recordFounderDecision: vi.fn().mockResolvedValue(null),
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    expireInformationRequest: vi.fn().mockResolvedValue(false),
    closeCase: vi.fn().mockResolvedValue(null),
    listCaseMessages,
    postCaseMessage,
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
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
      },
    }),
    repository,
    submitInitialCase,
    listCaseMessages,
    postCaseMessage,
  };
}

describe("owner origination-case workflow", () => {
  it("lists only through the owner-scoped repository query", async () => {
    const { app, repository } = buildApp();

    const response = await request(app).get("/v1/origination-cases?limit=10");

    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({
      case_id: "case_01",
      stage: "draft",
      property: { property_id: "prop_01", owner_declared_value_eur: "150000.00" },
    });
    expect(repository.listOwnedCases).toHaveBeenCalledWith({ accountId: "acct_01", limit: 11 });
  });

  it("hides a case outside the caller's account scope as not found", async () => {
    const { app } = buildApp({ caseRecord: null });

    const response = await request(app).get("/v1/origination-cases/case_other");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("origination.case_not_found");
  });

  it("rejects submission when mandatory initial evidence is absent", async () => {
    const { app, submitInitialCase } = buildApp();
    const body = { ...validSubmissionBody, documents: validSubmissionBody.documents.slice(0, 1) };

    const response = await request(app)
      .post("/v1/origination-cases/case_01/submit")
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("origination.required_evidence_missing");
    expect(submitInitialCase).not.toHaveBeenCalled();
  });

  it("rechecks KYC eligibility at submission time", async () => {
    const { app } = buildApp({ eligibilityState: "requires_renewal" });

    const response = await request(app)
      .post("/v1/origination-cases/case_01/submit")
      .send(validSubmissionBody);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("origination.submission_kyc_not_eligible");
  });

  it("rejects an already-submitted case", async () => {
    const { app } = buildApp({ caseRecord: { ...ownedCase, stage: "submitted" } });

    const response = await request(app)
      .post("/v1/origination-cases/case_01/submit")
      .send(validSubmissionBody);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("origination.case_submission_conflict");
  });

  it("normalizes a concurrent submission race to a conflict", async () => {
    const { app } = buildApp({ submissionConflict: true });

    const response = await request(app)
      .post("/v1/origination-cases/case_01/submit")
      .send(validSubmissionBody);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("origination.case_submission_conflict");
  });

  it("creates an immutable initial revision with durable attestations", async () => {
    const { app, submitInitialCase } = buildApp();

    const response = await request(app)
      .post("/v1/origination-cases/case_01/submit")
      .set("x-trace-id", "req_submit_test")
      .send(validSubmissionBody);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        case_id: "case_01",
        revision_id: "rev_01",
        revision_number: 1,
        stage: "submitted",
        submitted_at: "2026-08-31T11:00:00.000Z",
      },
    });
    expect(submitInitialCase).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_01",
        caseId: "case_01",
        traceId: "req_submit_test",
        submissionData: expect.objectContaining({
          ownership: validSubmissionBody.submission_data.ownership,
          attestations: expect.objectContaining({
            intake_terms_accepted: true,
            one_title_confirmed: true,
          }),
        }),
      }),
    );
  });
});

describe("owner case messages (applicant lane only)", () => {
  it("reads the applicant lane on the owner's own case", async () => {
    const { app, listCaseMessages } = buildApp({
      caseMessages: [
        {
          messageId: "msg_01",
          authorAccountId: "acct_founder",
          body: "Please clarify the encumbrance status.",
          createdAt: new Date("2026-09-01T09:00:00.000Z"),
        },
      ],
    });

    const response = await request(app).get("/v1/origination-cases/case_01/messages");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      expect.objectContaining({ message_id: "msg_01", author_account_id: "acct_founder" }),
    ]);
    expect(listCaseMessages).toHaveBeenCalledWith("case_01", "applicant");
  });

  it("404s reading messages on a case that isn't the caller's own", async () => {
    const { app, listCaseMessages } = buildApp({ caseRecord: null });

    const response = await request(app).get("/v1/origination-cases/case_01/messages");

    expect(response.status).toBe(404);
    expect(listCaseMessages).not.toHaveBeenCalled();
  });

  it("posts to the applicant lane as the owner, always — there is no other lane to choose", async () => {
    const { app, postCaseMessage } = buildApp();

    const response = await request(app)
      .post("/v1/origination-cases/case_01/messages")
      .send({ body: "Encumbrance was released in 2024, evidence attached." });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      body: "Encumbrance was released in 2024, evidence attached.",
    });
    expect(postCaseMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: "case_01",
        lane: "applicant",
        authorAccountId: "acct_01",
        body: "Encumbrance was released in 2024, evidence attached.",
      }),
    );
  });

  it("404s posting to a case that isn't the caller's own", async () => {
    const { app, postCaseMessage } = buildApp({ caseRecord: null });

    const response = await request(app)
      .post("/v1/origination-cases/case_01/messages")
      .send({ body: "Hello" });

    expect(response.status).toBe(404);
    expect(postCaseMessage).not.toHaveBeenCalled();
  });

  it("rejects an empty message body", async () => {
    const { app, postCaseMessage } = buildApp();

    const response = await request(app)
      .post("/v1/origination-cases/case_01/messages")
      .send({ body: "" });

    expect(response.status).toBe(422);
    expect(postCaseMessage).not.toHaveBeenCalled();
  });
});

function fakeStaffWebAuthnRepository() {
  return {
    listCredentials: vi.fn().mockResolvedValue([]),
    findCredential: vi.fn().mockResolvedValue(null),
    isSessionVerified: vi.fn().mockResolvedValue(false),
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
