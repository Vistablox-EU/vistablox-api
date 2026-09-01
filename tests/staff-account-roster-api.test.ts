import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { StaffAccountAdministrator } from "../src/modules/auth/application/staff-account-administrator.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";
import type {
  StaffAccountLifecycleRepository,
  StaffAccountLifecycleTarget,
  StaffAccountRosterEntry,
  StaffRoleAssignmentRecord,
} from "../src/modules/auth/repository/staff-account-lifecycle.repository.js";
import type { OriginationRepository } from "../src/modules/origination/repository/origination.repository.js";

const now = new Date("2026-09-01T12:00:00.000Z");

const activeTarget: StaffAccountLifecycleTarget = {
  accountId: "acct_target",
  betterAuthUserId: "auth_target",
  status: "active",
  hasActiveStaffRole: true,
};

const assignment: StaffRoleAssignmentRecord = {
  assignmentId: "role_01",
  role: "legal_partner",
  legalPracticeId: "practice_01",
  appraisalFirmId: null,
  grantedAt: now,
  revokedAt: null,
};

const rosterEntry: StaffAccountRosterEntry = {
  accountId: "acct_target",
  email: "target@example.test",
  status: "active",
  roles: [assignment],
};

function fakeLifecycleRepository(
  overrides: Partial<StaffAccountLifecycleRepository> = {},
): StaffAccountLifecycleRepository {
  return {
    findTarget: vi.fn().mockResolvedValue(activeTarget),
    prepareRecovery: vi.fn().mockResolvedValue(true),
    recordRecoveryDeliveryFailure: vi.fn().mockResolvedValue(undefined),
    completeOffboarding: vi.fn().mockResolvedValue(undefined),
    listStaffAccounts: vi.fn().mockResolvedValue([rosterEntry]),
    hasActiveRole: vi.fn().mockResolvedValue(false),
    grantRole: vi.fn().mockResolvedValue(assignment),
    revokeRole: vi.fn().mockResolvedValue(assignment),
    ...overrides,
  };
}

function fakeAdministrator(): StaffAccountAdministrator {
  return {
    prepareRecovery: vi.fn().mockResolvedValue(undefined),
    sendRecoveryEmail: vi.fn().mockResolvedValue(undefined),
    disableAndRevoke: vi.fn().mockResolvedValue(undefined),
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
  actorAccountId?: string;
  repository?: StaffAccountLifecycleRepository;
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
      accountId: options?.actorAccountId ?? "acct_admin",
      status: "active",
    }),
    hasActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(options?.hasAdminRole ?? true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
  };
  const repository = options?.repository ?? fakeLifecycleRepository();

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
        staffAccountLifecycle: {
          repository,
          administrator: fakeAdministrator(),
          recoveryRedirectUrl: "https://app.example.test/staff/reset-password",
        },
      },
    }),
    repository,
    accounts,
  };
}

describe("GET /internal/v1/auth/staff-accounts (roster)", () => {
  it("denies the internal surface to a customer", async () => {
    const { app } = buildApp({ population: "customer", hasAdminRole: true });

    const response = await request(app).get("/internal/v1/auth/staff-accounts");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies staff without an active admin operations assignment", async () => {
    const { app } = buildApp({ hasAdminRole: false });

    const response = await request(app).get("/internal/v1/auth/staff-accounts");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
  });

  it("denies an authorized administrator until WebAuthn is verified for the session", async () => {
    const { app } = buildApp({ mfaVerified: false });

    const response = await request(app).get("/internal/v1/auth/staff-accounts");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_mfa_required");
  });

  it("lists every staff account's full role history, active and revoked", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/auth/staff-accounts");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toEqual([
      {
        account_id: "acct_target",
        email: "target@example.test",
        status: "active",
        roles: [
          {
            assignment_id: "role_01",
            role: "legal_partner",
            legal_practice_id: "practice_01",
            appraisal_firm_id: null,
            granted_at: now.toISOString(),
            revoked_at: null,
          },
        ],
      },
    ]);
  });
});

describe("POST /internal/v1/auth/staff-accounts/:account_id/roles (grant)", () => {
  it("grants an additional role to an existing staff account", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/auth/staff-accounts/acct_target/roles")
      .send({ role: "legal_partner", legal_practice_id: "practice_01" });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      assignment_id: "role_01",
      role: "legal_partner",
      legal_practice_id: "practice_01",
    });
    expect(repository.grantRole).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_target",
        role: "legal_partner",
        legalPracticeId: "practice_01",
        appraisalFirmId: null,
        actorAccountId: "acct_admin",
      }),
    );
  });

  it("requires a legal_practice_id for a legal_partner grant", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/auth/staff-accounts/acct_target/roles")
      .send({ role: "legal_partner" });

    expect(response.status).toBe(422);
    expect(repository.grantRole).not.toHaveBeenCalled();
  });

  it("rejects granting a role the account already actively holds", async () => {
    const { app } = buildApp({
      repository: fakeLifecycleRepository({ hasActiveRole: vi.fn().mockResolvedValue(true) }),
    });

    const response = await request(app)
      .post("/internal/v1/auth/staff-accounts/acct_target/roles")
      .send({ role: "legal_partner", legal_practice_id: "practice_01" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("authentication.staff_role_already_granted");
  });

  it("blocks an administrator from granting a role to themselves", async () => {
    const { app, repository } = buildApp({ actorAccountId: "acct_target" });

    const response = await request(app)
      .post("/internal/v1/auth/staff-accounts/acct_target/roles")
      .send({ role: "legal_partner", legal_practice_id: "practice_01" });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_account_self_action_forbidden");
    expect(repository.grantRole).not.toHaveBeenCalled();
  });
});

describe("POST /internal/v1/auth/staff-accounts/:account_id/roles/:assignment_id/revoke", () => {
  it("revokes a single role assignment", async () => {
    const { app, repository } = buildApp();

    const response = await request(app).post(
      "/internal/v1/auth/staff-accounts/acct_target/roles/role_01/revoke",
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ revoked: true });
    expect(repository.revokeRole).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_target",
        assignmentId: "role_01",
        actorAccountId: "acct_admin",
      }),
    );
  });

  it("reports a conflict for an assignment that is already revoked or unknown", async () => {
    const { app } = buildApp({
      repository: fakeLifecycleRepository({ revokeRole: vi.fn().mockResolvedValue(null) }),
    });

    const response = await request(app).post(
      "/internal/v1/auth/staff-accounts/acct_target/roles/role_missing/revoke",
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("authentication.staff_account_target_unavailable");
  });

  it("blocks an administrator from revoking their own role", async () => {
    const { app, repository } = buildApp({ actorAccountId: "acct_target" });

    const response = await request(app).post(
      "/internal/v1/auth/staff-accounts/acct_target/roles/role_01/revoke",
    );

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authentication.staff_account_self_action_forbidden");
    expect(repository.revokeRole).not.toHaveBeenCalled();
  });
});
