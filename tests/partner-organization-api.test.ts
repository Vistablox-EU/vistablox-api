import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";
import type {
  AppraisalFirmRecord,
  LegalPracticeRecord,
  PartnerOrganizationRepository,
} from "../src/modules/origination/repository/partner-organization.repository.js";

const legalPractice: LegalPracticeRecord = {
  id: "legal_practice_01",
  name: "Avocats Example",
  countryCode: "FR",
  status: "active",
};

const appraisalFirm: AppraisalFirmRecord = {
  id: "appraisal_firm_01",
  name: "Example Valuations",
  countryCode: "DE",
  status: "active",
};

function fakePartnerOrganizationRepository(
  overrides: Partial<PartnerOrganizationRepository> = {},
): PartnerOrganizationRepository {
  return {
    createLegalPractice: vi.fn().mockResolvedValue(legalPractice),
    listLegalPractices: vi.fn().mockResolvedValue([legalPractice]),
    updateLegalPracticeStatus: vi.fn().mockResolvedValue({ ...legalPractice, status: "suspended" }),
    createAppraisalFirm: vi.fn().mockResolvedValue(appraisalFirm),
    listAppraisalFirms: vi.fn().mockResolvedValue([appraisalFirm]),
    updateAppraisalFirmStatus: vi.fn().mockResolvedValue({ ...appraisalFirm, status: "suspended" }),
    ...overrides,
  };
}

// origination routes are mounted unconditionally, so createApp requires a
// full OriginationRepository even though this file never exercises them.
function fakeOriginationRepository(): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn().mockResolvedValue([]),
    getOwnedCase: vi.fn().mockResolvedValue(null),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn().mockResolvedValue([]),
    getCaseForOperations: vi.fn().mockResolvedValue(null),
    getApplicantResponseWindowBusinessDays: vi.fn().mockResolvedValue(10),
    getInformationRequestReminderBusinessDays: vi.fn().mockResolvedValue([3, 7]),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn().mockResolvedValue(null),
    listOwnedInformationRequests: vi.fn().mockResolvedValue(null),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn().mockResolvedValue([]),
    expireInformationRequest: vi.fn().mockResolvedValue(false),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn().mockResolvedValue([]),
    postCaseMessage: vi.fn(),
  };
}

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

function buildApp(options?: {
  population?: "customer" | "staff_partner";
  hasAdminRole?: boolean;
  mfaVerified?: boolean;
  repository?: PartnerOrganizationRepository;
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
      accountId: "acct_admin",
      status: "active",
    }),
    hasActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
  };
  const repository = options?.repository ?? fakePartnerOrganizationRepository();

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
        originationRepository: fakeOriginationRepository(),
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(options?.mfaVerified ?? true),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
        partnerOrganizations: { repository },
      },
    }),
    repository,
  };
}

describe("legal practices admin API", () => {
  it("denies the surface to a customer", async () => {
    const { app } = buildApp({ population: "customer" });

    const response = await request(app).get("/internal/v1/legal-practices");

    expect(response.status).toBe(403);
  });

  it("denies an authorized administrator until WebAuthn is verified for the session", async () => {
    const { app } = buildApp({ mfaVerified: false });

    const response = await request(app).get("/internal/v1/legal-practices");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_mfa_required");
  });

  it("lists legal practices", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/legal-practices");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toEqual([
      { legal_practice_id: "legal_practice_01", name: "Avocats Example", country_code: "FR", status: "active" },
    ]);
  });

  it("creates a legal practice, upper-casing the country code", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/legal-practices")
      .send({ name: "Avocats Example", country_code: "fr" });

    expect(response.status).toBe(201);
    expect(repository.createLegalPractice).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Avocats Example", countryCode: "FR" }),
    );
  });

  it("rejects a create body with a malformed country code", async () => {
    const { app } = buildApp();

    const response = await request(app)
      .post("/internal/v1/legal-practices")
      .send({ name: "Avocats Example", country_code: "FRA" });

    expect(response.status).toBe(422);
  });

  it("updates a legal practice's status", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .patch("/internal/v1/legal-practices/legal_practice_01/status")
      .send({ status: "suspended" });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("suspended");
    expect(repository.updateLegalPracticeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legal_practice_01", status: "suspended" }),
    );
  });

  it("returns 404 for a status update on an unknown legal practice", async () => {
    const { app } = buildApp({
      repository: fakePartnerOrganizationRepository({
        updateLegalPracticeStatus: vi.fn().mockResolvedValue(null),
      }),
    });

    const response = await request(app)
      .patch("/internal/v1/legal-practices/legal_practice_missing/status")
      .send({ status: "suspended" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("origination.legal_practice_not_found");
  });
});

describe("appraisal firms admin API", () => {
  it("lists appraisal firms", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/appraisal-firms");

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      { appraisal_firm_id: "appraisal_firm_01", name: "Example Valuations", country_code: "DE", status: "active" },
    ]);
  });

  it("creates an appraisal firm", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/appraisal-firms")
      .send({ name: "Example Valuations", country_code: "de" });

    expect(response.status).toBe(201);
    expect(repository.createAppraisalFirm).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Example Valuations", countryCode: "DE" }),
    );
  });

  it("updates an appraisal firm's status", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .patch("/internal/v1/appraisal-firms/appraisal_firm_01/status")
      .send({ status: "suspended" });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("suspended");
    expect(repository.updateAppraisalFirmStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "appraisal_firm_01", status: "suspended" }),
    );
  });
});
