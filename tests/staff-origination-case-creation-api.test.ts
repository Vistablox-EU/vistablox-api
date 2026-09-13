import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository, AccountSummary } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import {
  ApplicantAccountNotFoundError,
  type CreatedStaffCase,
  type OriginationRepository,
} from "../src/modules/origination/repository/origination.repository.js";

const validDocuments = [
  { document_type: "ownership_declaration", document_ref: "doc-owner", extract_dated: null },
  { document_type: "property_facts_sheet", document_ref: "doc-facts", extract_dated: null },
  { document_type: "encumbrance_declaration", document_ref: "doc-enc", extract_dated: null },
  { document_type: "photo_set", document_ref: "doc-photos", extract_dated: null },
];

const validBody = {
  applicant_account_id: "acct_owner",
  intake_terms_accepted: true,
  one_title_confirmed: true,
  property: {
    property_type: "residential",
    country_code: "rs",
    city: "Belgrade",
    address_line: "Example 1",
    land_registry_reference: "BG-123",
    owner_declared_value_eur: "175000.00",
    has_existing_encumbrance: false,
  },
  documents: validDocuments,
};

function buildApp(options?: {
  population?: "customer" | "staff_partner";
  hasAdminRole?: boolean;
  mfaVerified?: boolean;
  minimumPropertyValueEur?: string;
  createStaffCase?: OriginationRepository["createStaffCase"];
  findByEmail?: AccountRepository["findByEmail"];
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
    findByEmail: options?.findByEmail ?? vi.fn().mockResolvedValue([]),
    hasActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
  };
  const createStaffCase =
    options?.createStaffCase ??
    vi.fn(async (): Promise<CreatedStaffCase> => ({
      caseId: "case_new",
      revisionId: "rev_new",
      revisionNumber: 1,
      stage: "submitted",
      submittedAt: new Date("2026-09-13T09:00:00.000Z"),
      applicantAccountId: "acct_owner",
    }));
  const repository: OriginationRepository = {
    getIntakePrerequisites: vi.fn(),
    getMinimumPropertyValueEur: vi.fn().mockResolvedValue(options?.minimumPropertyValueEur ?? "150000.00"),
    createDraftIntake: vi.fn(),
    createStaffCase,
    listOwnedCases: vi.fn().mockResolvedValue([]),
    getOwnedCase: vi.fn().mockResolvedValue(null),
    submitInitialCase: vi.fn().mockResolvedValue(null),
    listCasesForOperations: vi.fn().mockResolvedValue([]),
    getCaseForOperations: vi.fn().mockResolvedValue(null),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    publishInformationRequest: vi.fn().mockResolvedValue(null),
    getOwnedInformationRequest: vi.fn().mockResolvedValue(null),
    listOwnedInformationRequests: vi.fn().mockResolvedValue(null),
    resubmitAfterInformationRequest: vi.fn().mockResolvedValue(null),
    recordFounderDecision: vi.fn().mockResolvedValue(null),
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    expireInformationRequest: vi.fn().mockResolvedValue(false),
    closeCase: vi.fn().mockResolvedValue(null),
    reviewEvidence: vi.fn(),
    listCaseMessages: vi.fn().mockResolvedValue([]),
    postCaseMessage: vi.fn().mockResolvedValue(null),
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
        originationRepository: repository,
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(options?.mfaVerified ?? true),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
      },
    }),
    accounts,
    createStaffCase,
  };
}

describe("staff account search (GET /internal/v1/accounts)", () => {
  it("denies the internal surface to a customer", async () => {
    const { app } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).get("/internal/v1/accounts").query({ email: "a@example.test" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies an authorized staff account until WebAuthn is verified", async () => {
    const { app } = buildApp({ mfaVerified: false });

    const response = await request(app).get("/internal/v1/accounts").query({ email: "a@example.test" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_mfa_required");
  });

  it("returns every account sharing the searched email, trimmed and passed through as-is", async () => {
    const summaries: AccountSummary[] = [
      { accountId: "acct_owner", email: "Applicant@Example.test", status: "active" },
    ];
    const findByEmail = vi.fn().mockResolvedValue(summaries);
    const { app } = buildApp({ findByEmail });

    const response = await request(app)
      .get("/internal/v1/accounts")
      .query({ email: "  Applicant@Example.test  " });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { account_id: "acct_owner", email: "Applicant@Example.test", status: "active" },
    ]);
    expect(findByEmail).toHaveBeenCalledWith("Applicant@Example.test");
  });

  it("rejects a missing email query parameter", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/accounts");

    expect(response.status).toBe(422);
  });
});

describe("staff create-and-submit an origination case (POST /internal/v1/origination-cases)", () => {
  it("denies the internal surface to a customer", async () => {
    const { app } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).post("/internal/v1/origination-cases").send(validBody);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("creates and submits a case in one action, attributing the revision to the staff caller", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app).post("/internal/v1/origination-cases").send(validBody);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      case_id: "case_new",
      revision_id: "rev_new",
      revision_number: 1,
      stage: "submitted",
      applicant_account_id: "acct_owner",
    });
    expect(createStaffCase).toHaveBeenCalledWith(
      expect.objectContaining({
        applicantAccountId: "acct_owner",
        staffAccountId: "acct_founder",
        property: expect.objectContaining({
          countryCode: "RS",
          ownerDeclaredValueEur: "175000.00",
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
        }),
        documents: expect.arrayContaining([
          expect.objectContaining({ documentType: "ownership_declaration", documentRef: "doc-owner" }),
        ]),
      }),
    );
  });

  it("threads the structured property fields through when supplied", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({
        ...validBody,
        property: {
          ...validBody.property,
          residential_subtype: "apartment",
          living_area_sq_m: 82.5,
          bedrooms: 2,
          bathrooms: 1,
          floor: 3,
          total_floors: 6,
          year_built: 1998,
          condition: "good",
          energy_rating: "C",
        },
      });

    expect(response.status).toBe(201);
    expect(createStaffCase).toHaveBeenCalledWith(
      expect.objectContaining({
        property: expect.objectContaining({
          residentialSubtype: "apartment",
          livingAreaSqM: 82.5,
          bedrooms: 2,
          bathrooms: 1,
          floor: 3,
          totalFloors: 6,
          yearBuilt: 1998,
          condition: "good",
          energyRating: "C",
        }),
      }),
    );
  });

  it("threads a room breakdown through when supplied", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({
        ...validBody,
        property: {
          ...validBody.property,
          rooms: [
            { room_type: "bedroom", size_sq_m: 14.2 },
            { room_type: "bathroom", size_sq_m: 5.5 },
          ],
        },
      });

    expect(response.status).toBe(201);
    expect(createStaffCase).toHaveBeenCalledWith(
      expect.objectContaining({
        property: expect.objectContaining({
          rooms: [
            { roomType: "bedroom", sizeSqM: 14.2 },
            { roomType: "bathroom", sizeSqM: 5.5 },
          ],
        }),
      }),
    );
  });

  it("rejects a room breakdown over the 30-room cap", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({
        ...validBody,
        property: {
          ...validBody.property,
          rooms: Array.from({ length: 31 }, () => ({ room_type: "other", size_sq_m: 5 })),
        },
      });

    expect(response.status).toBe(422);
    expect(createStaffCase).not.toHaveBeenCalled();
  });

  it("rejects an out-of-enum room_type at the schema layer", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({
        ...validBody,
        property: {
          ...validBody.property,
          rooms: [{ room_type: "garage", size_sq_m: 20 }],
        },
      });

    expect(response.status).toBe(422);
    expect(createStaffCase).not.toHaveBeenCalled();
  });

  it("rejects an out-of-enum residential_subtype at the schema layer", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({ ...validBody, property: { ...validBody.property, residential_subtype: "castle" } });

    expect(response.status).toBe(422);
    expect(createStaffCase).not.toHaveBeenCalled();
  });

  it("rejects a submission missing one of the four required evidence types", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({ ...validBody, documents: validDocuments.slice(0, 3) });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("origination.required_evidence_missing");
    expect(createStaffCase).not.toHaveBeenCalled();
  });

  it("rejects a submission with a duplicated evidence type", async () => {
    const { app, createStaffCase } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({ ...validBody, documents: [...validDocuments, validDocuments[0]] });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("origination.duplicate_evidence_type");
    expect(createStaffCase).not.toHaveBeenCalled();
  });

  it("rejects a property value below the platform's minimum floor", async () => {
    const { app, createStaffCase } = buildApp({ minimumPropertyValueEur: "150000.00" });

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({
        ...validBody,
        property: { ...validBody.property, owner_declared_value_eur: "100000.00" },
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("origination.property_value_below_minimum");
    expect(createStaffCase).not.toHaveBeenCalled();
  });

  it("returns 404 when the applicant account id does not resolve to a real account", async () => {
    const createStaffCase = vi.fn().mockRejectedValue(new ApplicantAccountNotFoundError("acct_missing"));
    const { app } = buildApp({ createStaffCase });

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({ ...validBody, applicant_account_id: "acct_missing" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("origination.applicant_account_not_found");
  });

  it("rejects a non-residential property type at the schema layer", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/internal/v1/origination-cases")
      .send({ ...validBody, property: { ...validBody.property, property_type: "commercial" } });

    expect(response.status).toBe(422);
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
