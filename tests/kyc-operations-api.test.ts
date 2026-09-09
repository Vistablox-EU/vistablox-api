import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { KycServiceGateway } from "../src/modules/identity/application/kyc-service-gateway.js";
import { AppError } from "../src/shared/errors/app-error.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";

const operationsRecord = {
  account_id: "acct_reviewed",
  eligibility_state: "pending_manual_review",
  operational_substatus: "kyc_manual_review",
  didit_reference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  residence_country_code: "DE",
  tax_residence_country_code: "HR",
  proof_of_address_status: "not_started",
  proof_of_address_didit_reference: null,
  proof_of_address_provider_status: null,
  proof_of_address_provider_updated_at: null,
  proof_of_address_current_until: null,
  last_verified_at: null,
  ever_required_manual_review: true,
  renewal_due_at: null,
};

function fakeKycServiceGateway(overrides: Partial<KycServiceGateway> = {}): KycServiceGateway {
  return {
    getStatus: vi.fn(),
    startSession: vi.fn(),
    startProofOfAddressSession: vi.fn(),
    getAccountForOperations: vi.fn().mockResolvedValue({ data: operationsRecord }),
    getDisplayProfile: vi.fn().mockResolvedValue({ data: null }),
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
    getCasePartnerAssignment: vi.fn().mockResolvedValue(null),
    assignPartnerOrganization: vi.fn().mockResolvedValue(null),
    listCasesForPartner: vi.fn().mockResolvedValue([]),
    getCaseForPartner: vi.fn().mockResolvedValue(null),
    recordLegalStructuring: vi.fn().mockResolvedValue(null),
    recordAppraisal: vi.fn().mockResolvedValue(null),
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
  kycGateway?: KycServiceGateway;
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
      accountId: options?.population === "customer" ? "acct_customer" : "acct_founder",
      status: "active",
    }),
    hasActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
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
        originationRepository: fakeOriginationRepository(),
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(options?.mfaVerified ?? true),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
        kyc: {
          client: options?.kycGateway ?? fakeKycServiceGateway(),
        },
      },
    }),
    accounts,
  };
}

describe("operations KYC decision display", () => {
  it("denies the internal surface to a customer even if a role lookup would pass", async () => {
    const { app, accounts } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).get("/internal/v1/kyc-accounts/acct_reviewed");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
    expect(accounts.hasActiveStaffRole).not.toHaveBeenCalled();
  });

  it("denies staff without an active admin operations assignment", async () => {
    const { app } = buildApp({ hasAdminRole: false });

    const response = await request(app).get("/internal/v1/kyc-accounts/acct_reviewed");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies an authorized reviewer until WebAuthn is verified for the session", async () => {
    const { app } = buildApp({ mfaVerified: false });

    const response = await request(app).get("/internal/v1/kyc-accounts/acct_reviewed");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_mfa_required");
  });

  it("returns the operational KYC record to an authorized, WebAuthn-verified reviewer", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/kyc-accounts/acct_reviewed");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      account_id: "acct_reviewed",
      eligibility_state: "pending_manual_review",
      operational_substatus: "kyc_manual_review",
      residence_country_code: "DE",
      tax_residence_country_code: "HR",
      ever_required_manual_review: true,
    });
  });

  it("reports 404 for an account with no KYC record", async () => {
    const { app } = buildApp({
      kycGateway: fakeKycServiceGateway({
        getAccountForOperations: vi.fn().mockRejectedValue(
          new AppError({
            code: "identity.kyc_account_not_found",
            title: "KYC record not found",
            status: 404,
            detail: "No KYC eligibility record was found for that account.",
          }),
        ),
      }),
    });

    const response = await request(app).get("/internal/v1/kyc-accounts/acct_unknown");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("identity.kyc_account_not_found");
  });
});
