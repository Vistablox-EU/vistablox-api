import pino from "pino";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/shared/session-resolver.js";
import type { IntakeRepository } from "../src/modules/intake/repository/intake.repository.js";
import type {
  OnrampLateEvidenceRecord,
  OnrampLateEvidenceReviewRepository,
} from "../src/modules/offering/repository/onramp-late-evidence.repository.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";

// The staff routes of the late-evidence list as createApp mounts them, not as
// a test builds them. tests/onramp-late-evidence-api.test.ts runs the router
// over the real gates in an app of its own, and tests/onramp-late-evidence-
// wiring.test.ts checks the mount from the source text; neither notices
// createApp handing the router a weaker gate (say requireAuthentication for all
// three), which would let any signed-in customer read the list (destination
// wallets, transaction hashes, amounts) and mark entries reviewed. This does:
// it goes through createApp, with the session, account, role and WebAuthn
// lookups faked at the edge and the real gates in between.

const wallet = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const reviewedAt = new Date("2026-11-17T13:00:00.000Z");
const base = "/internal/v1/offerings/onramp-late-evidence";
const markPath = `${base}/onramp_late_evidence_02/mark-reviewed`;

function record(overrides: Partial<OnrampLateEvidenceRecord> = {}): OnrampLateEvidenceRecord {
  return {
    evidenceId: "onramp_late_evidence_02",
    providerTransactionId: "txn_late",
    txHash: "0xabc",
    destinationWallet: wallet,
    reservationId: "reservation_01",
    reservationStage: "lapsed",
    currentReservationStage: "lapsed",
    amount: "950.000000",
    asset: "EURC",
    state: "eurc_reserved",
    observedAt: new Date("2026-11-17T10:00:00.000Z"),
    reviewedAt: null,
    ...overrides,
  };
}

function fakeEmailSender(): EmailSender {
  return {
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn(),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    sendAccountRecoveryCaseOpenedEmail: vi.fn(),
    sendAccountRecoveryApprovedEmail: vi.fn(),
    sendAccountRecoveryRejectedEmail: vi.fn(),
    sendAccountRecoveryCompletedEmail: vi.fn(),
    sendPasskeyRecoveryEmail: vi.fn(),
    sendDeviceReplacementCodeEmail: vi.fn(),
  };
}

// createApp mounts the intake routes unconditionally and needs a repository for
// them; this file never reaches them.
function fakeIntakeRepository(): IntakeRepository {
  return new Proxy({}, { get: () => vi.fn() }) as unknown as IntakeRepository;
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

interface Caller {
  /** false: no session at all, so authentication answers 401. */
  signedIn?: boolean;
  population?: "customer" | "staff_partner";
  /** Holds admin_operations. Every other role is held either way, so only this one decides. */
  adminOperations?: boolean;
  /** The session has passed staff WebAuthn. */
  webAuthnVerified?: boolean;
}

function buildApp(caller: Caller = {}, options: { mounted?: boolean } = {}) {
  const { signedIn = true, population = "staff_partner", adminOperations = true, webAuthnVerified = true } = caller;
  const listLateEvidence = vi.fn().mockResolvedValue([record()]);
  const markLateEvidenceReviewed = vi.fn().mockResolvedValue({ status: "reviewed", entry: record({ reviewedAt }) });
  const repository: OnrampLateEvidenceReviewRepository = { listLateEvidence, markLateEvidenceReviewed };

  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue(
      signedIn ? { betterAuthUserId: "auth_actor", providerSessionId: "session_actor", population } : null,
    ),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "account_actor", status: "active" }),
    findByEmail: vi.fn(),
    hasActiveStaffRole: vi.fn(async (_accountId: string, role: string) => role !== "admin_operations" || adminOperations),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
  };

  const app = createApp({
    databaseProbe: { check: vi.fn() },
    offeringRepository: { listPublic: vi.fn().mockResolvedValue([]), getInvestorDetail: vi.fn().mockResolvedValue(null) },
    logger: pino({ level: "silent" }),
    corsOrigins: [],
    protectedApi: {
      accounts,
      sessions,
      intakeRepository: fakeIntakeRepository(),
      emailSender: fakeEmailSender(),
      staffWebAuthnRepository: fakeStaffWebAuthnRepository(webAuthnVerified),
      staffWebAuthnCeremony: fakeStaffWebAuthnCeremony(),
      ...(options.mounted === false ? {} : { onrampLateEvidence: { repository } }),
    },
  });
  return { app, listLateEvidence, markLateEvidenceReviewed };
}

const denied: Array<[string, Caller, number, string]> = [
  ["nobody is signed in", { signedIn: false }, 401, "authentication.required"],
  ["a customer", { population: "customer", adminOperations: false }, 403, "authorization.forbidden"],
  // The role check is on the staff population as well as the role: a customer
  // session is refused even if a role lookup would say yes.
  ["a customer account that holds the admin_operations role", { population: "customer", adminOperations: true }, 403, "authorization.forbidden"],
  ["a staff account without admin_operations", { adminOperations: false }, 403, "authorization.forbidden"],
  ["an admin_operations account whose session has not passed WebAuthn", { webAuthnVerified: false }, 403, "authentication.staff_mfa_required"],
];

describe("the late-evidence staff routes as createApp mounts them", () => {
  describe.each([
    ["GET the list", (app: ReturnType<typeof buildApp>["app"]) => request(app).get(base)],
    ["POST mark-reviewed", (app: ReturnType<typeof buildApp>["app"]) => request(app).post(markPath)],
  ])("%s", (_name, call) => {
    it.each(denied)("refuses %s, and never reaches the repository", async (_who, caller, status, code) => {
      const { app, listLateEvidence, markLateEvidenceReviewed } = buildApp(caller);

      const response = await call(app);

      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
      expect(listLateEvidence).not.toHaveBeenCalled();
      expect(markLateEvidenceReviewed).not.toHaveBeenCalled();
      // Nothing of the list in the refusal either.
      expect(JSON.stringify(response.body)).not.toContain(wallet);
    });
  });

  it("lets a WebAuthn-verified admin_operations account read the list", async () => {
    const { app, listLateEvidence } = buildApp();

    const response = await request(app).get(base);

    expect(response.status).toBe(200);
    expect(listLateEvidence).toHaveBeenCalledWith({ limit: 25 });
    expect(response.body.data).toEqual([
      expect.objectContaining({
        evidence_id: "onramp_late_evidence_02",
        provider_transaction_id: "txn_late",
        destination_wallet: wallet,
        reviewed_at: null,
      }),
    ]);
  });

  it("lets a WebAuthn-verified admin_operations account mark an entry reviewed, as that account", async () => {
    const { app, markLateEvidenceReviewed } = buildApp();

    const response = await request(app).post(markPath);

    expect(response.status).toBe(200);
    expect(markLateEvidenceReviewed).toHaveBeenCalledTimes(1);
    expect(markLateEvidenceReviewed).toHaveBeenCalledWith(
      expect.objectContaining({ evidenceId: "onramp_late_evidence_02", actorAccountId: "account_actor" }),
    );
    expect(response.body).toMatchObject({ data: { evidence_id: "onramp_late_evidence_02", reviewed_at: reviewedAt.toISOString() } });
  });

  it("offers staff nothing else on the prefix: there is no way to resolve, hold, reinstate or refund an entry", async () => {
    const { app, listLateEvidence, markLateEvidenceReviewed } = buildApp();

    for (const attempt of [
      request(app).post(base),
      request(app).patch(`${base}/onramp_late_evidence_02`),
      request(app).delete(`${base}/onramp_late_evidence_02`),
      request(app).post(`${base}/onramp_late_evidence_02/refund`),
      request(app).post(`${base}/onramp_late_evidence_02/reinstate`),
    ]) {
      expect((await attempt).status).toBe(404);
    }
    expect(listLateEvidence).not.toHaveBeenCalled();
    expect(markLateEvidenceReviewed).not.toHaveBeenCalled();
  });

  it("is not mounted without a repository: the same authorised staff caller gets 404, not a half-wired route", async () => {
    const { app } = buildApp({}, { mounted: false });

    expect((await request(app).get(base)).status).toBe(404);
    expect((await request(app).post(markPath)).status).toBe(404);
  });
});
