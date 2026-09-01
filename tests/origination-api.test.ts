import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type {
  CreateDraftIntakeInput,
  OriginationRepository,
} from "../src/modules/origination/repository/origination.repository.js";

const validBody = {
  intake_terms_accepted: true,
  one_title_confirmed: true,
  property: {
    property_type: "residential",
    country_code: "rs",
    city: "Belgrade",
    address_line: "Example 1",
    land_registry_reference: "BG-123",
    latitude: 44.8125,
    longitude: 20.4612,
    owner_declared_value_eur: "150000.00",
    has_existing_encumbrance: false,
  },
};

function buildProtectedApp(options?: {
  unauthenticated?: boolean;
  accountStatus?: "active" | "recovery_review" | "suspended_restricted";
  eligibilityState?: string;
  proofOfAddressCurrentUntil?: Date | null;
  minimumPropertyValueEur?: string;
}) {
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue(
      options?.unauthenticated === true
        ? null
        : {
            betterAuthUserId: "auth_user_01",
            providerSessionId: "auth_session_01",
            population: "customer",
          },
    ),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({
      accountId: "acct_01",
      status: options?.accountStatus ?? "active",
    }),
    hasActiveStaffRole: vi.fn().mockResolvedValue(false),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(false),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
  };
  const createDraftIntake = vi.fn(async (_input: CreateDraftIntakeInput) => ({
    caseId: "case_01",
    propertyId: "prop_01",
    stage: "draft" as const,
  }));
  const originationRepository: OriginationRepository = {
    getIntakePrerequisites: vi.fn().mockResolvedValue({
      eligibilityState: options?.eligibilityState ?? "eligible",
      proofOfAddressCurrentUntil:
        options?.proofOfAddressCurrentUntil === undefined
          ? new Date("2099-01-01T00:00:00.000Z")
          : options.proofOfAddressCurrentUntil,
      minimumPropertyValueEur: options?.minimumPropertyValueEur ?? "150000.00",
    }),
    createDraftIntake,
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
  };

  return {
    app: createApp({
      databaseProbe: { check: vi.fn() },
      offeringRepository: { listPublic: vi.fn().mockResolvedValue([]) },
      logger: pino({ level: "silent" }),
      protectedApi: {
        accounts,
        sessions,
        originationRepository,
        staffWebAuthnRepository: fakeStaffWebAuthnRepository(),
        staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
      },
    }),
    createDraftIntake,
  };
}

describe("POST /v1/origination-cases", () => {
  it("requires a valid session", async () => {
    const { app } = buildProtectedApp({ unauthenticated: true });

    const response = await request(app).post("/v1/origination-cases").send(validBody);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("authentication.required");
  });

  it("blocks restricted local accounts before domain work", async () => {
    const { app } = buildProtectedApp({ accountStatus: "suspended_restricted" });

    const response = await request(app).post("/v1/origination-cases").send(validBody);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("account.restricted");
  });

  it("enforces KYC eligibility", async () => {
    const { app } = buildProtectedApp({ eligibilityState: "in_progress" });

    const response = await request(app).post("/v1/origination-cases").send(validBody);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("identity.kyc_required");
  });

  it("requires current proof of address", async () => {
    const { app } = buildProtectedApp({ proofOfAddressCurrentUntil: null });

    const response = await request(app).post("/v1/origination-cases").send(validBody);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("identity.proof_of_address_required");
  });

  it("enforces the database-backed property-value floor", async () => {
    const { app } = buildProtectedApp({ minimumPropertyValueEur: "200000.00" });

    const response = await request(app).post("/v1/origination-cases").send(validBody);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: "origination.property_value_below_minimum",
      field_errors: [{ field: "property.owner_declared_value_eur" }],
    });
  });

  it("creates an audited draft intake for an eligible owner", async () => {
    const { app, createDraftIntake } = buildProtectedApp();

    const response = await request(app)
      .post("/v1/origination-cases")
      .set("x-trace-id", "req_test_trace")
      .send(validBody);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      data: { case_id: "case_01", property_id: "prop_01", stage: "draft" },
    });
    expect(createDraftIntake).toHaveBeenCalledWith({
      accountId: "acct_01",
      traceId: "req_test_trace",
      property: {
        countryCode: "RS",
        city: "Belgrade",
        addressLine: "Example 1",
        landRegistryReference: "BG-123",
        latitude: 44.8125,
        longitude: 20.4612,
        ownerDeclaredValueEur: "150000.00",
        hasExistingEncumbrance: false,
      },
    });
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
