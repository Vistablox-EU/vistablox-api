import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import { createRequirePartnerCaseAssignment } from "../src/modules/origination/api/require-partner-case-assignment.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function fakeAccounts(activeOrganizationId: string | null): AccountRepository {
  return {
    findByBetterAuthUserId: vi.fn(),
    hasActiveStaffRole: vi.fn(),
    hasAnyActiveStaffRole: vi.fn(),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(activeOrganizationId),
  };
}

function fakeCases(
  assignment: { stage: string; legalPracticeId: string | null; appraisalFirmId: string | null } | null,
): OriginationRepository {
  return {
    getIntakePrerequisites: vi.fn(),
    createDraftIntake: vi.fn(),
    listOwnedCases: vi.fn(),
    getOwnedCase: vi.fn(),
    submitInitialCase: vi.fn(),
    listCasesForOperations: vi.fn(),
    getCaseForOperations: vi.fn(),
    getCasePartnerAssignment: vi.fn().mockResolvedValue(assignment),
    assignPartnerOrganization: vi.fn(),
    getApplicantResponseWindowBusinessDays: vi.fn(),
    getInformationRequestReminderBusinessDays: vi.fn(),
    publishInformationRequest: vi.fn(),
    getOwnedInformationRequest: vi.fn(),
    listOwnedInformationRequests: vi.fn(),
    resubmitAfterInformationRequest: vi.fn(),
    recordFounderDecision: vi.fn(),
    closeCase: vi.fn(),
    listCaseMessages: vi.fn(),
    postCaseMessage: vi.fn(),
    listPublishedInformationRequestsForTimers: vi.fn(),
    expireInformationRequest: vi.fn(),
  };
}

function buildApp(
  role: "legal_partner" | "appraisal_partner",
  accounts: AccountRepository,
  cases: OriginationRepository,
) {
  const app = express();
  app.use(requestContext);
  app.get(
    "/cases/:case_id",
    (_request, response, next) => {
      response.locals.authContext = {
        accountId: "acct_partner",
        providerSessionId: "session_01",
        population: "staff_partner" as const,
      };
      next();
    },
    createRequirePartnerCaseAssignment(role, accounts, cases),
    (_request, response) => response.json({ ok: true }),
  );
  app.use(errorHandler);
  return app;
}

describe("require partner case assignment", () => {
  it("allows a legal partner whose practice is assigned to a post-IPO-structuring case", async () => {
    const app = buildApp(
      "legal_partner",
      fakeAccounts("legal_practice_01"),
      fakeCases({ stage: "post_ipo_structuring", legalPracticeId: "legal_practice_01", appraisalFirmId: null }),
    );

    const response = await request(app).get("/cases/case_01");

    expect(response.status).toBe(200);
  });

  it("allows access once the case has reached approved_for_final_offering", async () => {
    const app = buildApp(
      "appraisal_partner",
      fakeAccounts("appraisal_firm_01"),
      fakeCases({ stage: "approved_for_final_offering", legalPracticeId: null, appraisalFirmId: "appraisal_firm_01" }),
    );

    const response = await request(app).get("/cases/case_01");

    expect(response.status).toBe(200);
  });

  it("denies a legal partner whose practice is not the one assigned to the case", async () => {
    const app = buildApp(
      "legal_partner",
      fakeAccounts("legal_practice_01"),
      fakeCases({ stage: "post_ipo_structuring", legalPracticeId: "legal_practice_02", appraisalFirmId: null }),
    );

    const response = await request(app).get("/cases/case_01");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies access before the case has reached an accessible stage, even if assigned", async () => {
    const app = buildApp(
      "legal_partner",
      fakeAccounts("legal_practice_01"),
      fakeCases({ stage: "pre_offering_open", legalPracticeId: "legal_practice_01", appraisalFirmId: null }),
    );

    const response = await request(app).get("/cases/case_01");

    expect(response.status).toBe(403);
  });

  it("denies access when the account holds no active assignment for the role", async () => {
    const app = buildApp(
      "legal_partner",
      fakeAccounts(null),
      fakeCases({ stage: "post_ipo_structuring", legalPracticeId: "legal_practice_01", appraisalFirmId: null }),
    );

    const response = await request(app).get("/cases/case_01");

    expect(response.status).toBe(403);
  });

  it("denies access to a case that does not exist, indistinguishably from a mismatched assignment", async () => {
    const app = buildApp("legal_partner", fakeAccounts("legal_practice_01"), fakeCases(null));

    const response = await request(app).get("/cases/case_missing");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("does not let an appraisal firm's assignment satisfy a legal_partner check", async () => {
    const app = buildApp(
      "legal_partner",
      fakeAccounts("org_01"),
      fakeCases({ stage: "post_ipo_structuring", legalPracticeId: null, appraisalFirmId: "org_01" }),
    );

    const response = await request(app).get("/cases/case_01");

    expect(response.status).toBe(403);
  });
});
