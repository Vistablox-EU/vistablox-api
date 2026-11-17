import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createRequireAdminOperations, createRequireStaffWebAuthn } from "../src/modules/auth/api/staff/require-staff-role.js";
import { createOnrampLateEvidenceRouter } from "../src/modules/offering/api/onramp-late-evidence.router.js";
import { ListOnrampLateEvidenceService } from "../src/modules/offering/application/list-onramp-late-evidence.service.js";
import { MarkOnrampLateEvidenceReviewedService } from "../src/modules/offering/application/mark-onramp-late-evidence-reviewed.service.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { StaffMfaSessionVerifier } from "../src/modules/auth/application/staff/staff-mfa-session-verifier.js";
import type {
  OnrampLateEvidenceRecord,
  OnrampLateEvidenceReviewRepository,
} from "../src/modules/offering/repository/onramp-late-evidence.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const wallet = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const reviewedAt = new Date("2026-11-17T13:00:00.000Z");

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

const entryBody = {
  evidence_id: "onramp_late_evidence_02",
  provider_transaction_id: "txn_late",
  tx_hash: "0xabc",
  destination_wallet: wallet,
  reservation_id: "reservation_01",
  reservation_stage: "lapsed",
  current_reservation_stage: "lapsed",
  reason: "reservation_lapsed",
  amount: "950.000000",
  asset: "EURC",
  state: "eurc_reserved",
  observed_at: "2026-11-17T10:00:00.000Z",
  reviewed_at: null,
};

type Who = { population: "customer" | "staff_partner"; accountId: string; adminOperations: boolean; mfa: boolean };
const founder: Who = { population: "staff_partner", accountId: "account_founder", adminOperations: true, mfa: true };

// The real admin_operations and staff WebAuthn gates, over fake account and
// MFA lookups, so a role or step-up the gate would refuse is refused here too.
// Only authentication is faked: it says who is calling, from a header.
function buildApp(options: {
  rows?: OnrampLateEvidenceRecord[];
  marked?: Awaited<ReturnType<OnrampLateEvidenceReviewRepository["markLateEvidenceReviewed"]>>;
} = {}) {
  const listLateEvidence = vi.fn().mockResolvedValue(options.rows ?? []);
  const markLateEvidenceReviewed = vi
    .fn()
    .mockResolvedValue(options.marked ?? { status: "reviewed", entry: record({ reviewedAt }) });
  const repository: OnrampLateEvidenceReviewRepository = { listLateEvidence, markLateEvidenceReviewed };

  // Who is calling, by account id, as the role and MFA lookups would know them.
  const directory = new Map<string, Who>();
  const authenticated: RequestHandler = (httpRequest, response, next) => {
    const header = httpRequest.header("x-test-who");
    if (header === undefined) {
      next(new AppError({ code: "authentication.required", title: "Authentication required", status: 401, detail: "Sign in." }));
      return;
    }
    const who = JSON.parse(header) as Who;
    directory.set(who.accountId, who);
    response.locals.authContext = { accountId: who.accountId, providerSessionId: `session_${who.accountId}`, population: who.population };
    next();
  };
  const accounts = {
    hasActiveStaffRole: vi.fn(
      async (accountId: string, role: string) => role === "admin_operations" && directory.get(accountId)?.adminOperations === true,
    ),
  } as unknown as AccountRepository;
  const verifier = {
    isSessionVerified: vi.fn(async (accountId: string) => directory.get(accountId)?.mfa === true),
  } as unknown as StaffMfaSessionVerifier;

  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/internal/v1/offerings/onramp-late-evidence",
    createOnrampLateEvidenceRouter(
      authenticated,
      createRequireAdminOperations(accounts),
      createRequireStaffWebAuthn(verifier),
      new ListOnrampLateEvidenceService(repository),
      new MarkOnrampLateEvidenceReviewedService(repository, () => reviewedAt),
    ),
  );
  app.use(errorHandler);
  return { app, listLateEvidence, markLateEvidenceReviewed };
}

const as = (who: Who) => JSON.stringify(who);
const base = "/internal/v1/offerings/onramp-late-evidence";

describe("GET /internal/v1/offerings/onramp-late-evidence", () => {
  it("lists the entries for staff, with the fields the founder named", async () => {
    const { app, listLateEvidence } = buildApp({ rows: [record()] });

    const response = await request(app).get(base).set("x-test-who", as(founder));

    expect(response.status).toBe(200);
    expect(listLateEvidence).toHaveBeenCalledWith({ limit: 25 });
    expect(response.body).toEqual({ data: [entryBody], page: { next_cursor: null } });
  });

  it("reads each stage as its reason, and keeps the stage seen and the stage now apart", async () => {
    const { app } = buildApp({
      rows: [
        record({ evidenceId: "e3", reservationStage: "cancelled", currentReservationStage: "cancelled" }),
        record({ evidenceId: "e2", reservationStage: "awaiting_reconfirmation", currentReservationStage: "finalized" }),
        record({ evidenceId: "e1", reservationStage: "lapsed", currentReservationStage: "lapsed", state: "purchase_failed" }),
      ],
    });

    const response = await request(app).get(base).set("x-test-who", as(founder));

    expect(response.body.data.map((entry: Record<string, unknown>) => [entry.evidence_id, entry.reservation_stage, entry.current_reservation_stage, entry.reason])).toEqual([
      ["e3", "cancelled", "cancelled", "reservation_cancelled"],
      ["e2", "awaiting_reconfirmation", "finalized", "reservation_funded_already"],
      ["e1", "lapsed", "lapsed", "reservation_lapsed"],
    ]);
  });

  it("pages with an exclusive after cursor and filters on the review state", async () => {
    const { app, listLateEvidence } = buildApp({
      rows: [record({ evidenceId: "onramp_late_evidence_03" }), record({ evidenceId: "onramp_late_evidence_02" })],
    });

    const response = await request(app)
      .get(`${base}?limit=1&after=onramp_late_evidence_04&review_state=unreviewed`)
      .set("x-test-who", as(founder));

    expect(response.status).toBe(200);
    expect(listLateEvidence).toHaveBeenCalledWith({ limit: 1, after: "onramp_late_evidence_04", reviewState: "unreviewed" });
    expect(response.body.data).toHaveLength(1);
    expect(response.body.page).toEqual({ next_cursor: "onramp_late_evidence_03" });
  });

  it.each(["held", "refunded", "resolved", "pending_review"])(
    "rejects the review state %s: an entry is unreviewed or reviewed, nothing else",
    async (reviewState) => {
      const { app, listLateEvidence } = buildApp();

      const response = await request(app).get(`${base}?review_state=${reviewState}`).set("x-test-who", as(founder));

      expect(response.status).toBe(422);
      expect(response.body.field_errors).toBeDefined();
      expect(listLateEvidence).not.toHaveBeenCalled();
    },
  );
});

describe("POST /internal/v1/offerings/onramp-late-evidence/:evidence_id/mark-reviewed", () => {
  it("marks the entry reviewed on behalf of the calling staff account, and returns it", async () => {
    const { app, markLateEvidenceReviewed } = buildApp();

    const response = await request(app).post(`${base}/onramp_late_evidence_02/mark-reviewed`).set("x-test-who", as(founder));

    expect(response.status).toBe(200);
    expect(markLateEvidenceReviewed).toHaveBeenCalledTimes(1);
    expect(markLateEvidenceReviewed).toHaveBeenCalledWith({
      evidenceId: "onramp_late_evidence_02",
      actorAccountId: "account_founder",
      traceId: expect.stringMatching(/.+/),
      reviewedAt,
    });
    expect(response.body).toEqual({ data: { ...entryBody, reviewed_at: "2026-11-17T13:00:00.000Z" } });
  });

  it("answers an already reviewed entry the same way, with the first review time", async () => {
    const first = new Date("2026-11-17T11:00:00.000Z");
    const { app } = buildApp({ marked: { status: "already_reviewed", entry: record({ reviewedAt: first }) } });

    const response = await request(app).post(`${base}/onramp_late_evidence_02/mark-reviewed`).set("x-test-who", as(founder));

    expect(response.status).toBe(200);
    expect(response.body.data.reviewed_at).toBe("2026-11-17T11:00:00.000Z");
  });

  it("answers 404 in the documented envelope for an entry that does not exist", async () => {
    const { app } = buildApp({ marked: { status: "not_found" } });

    const response = await request(app).post(`${base}/onramp_late_evidence_missing/mark-reviewed`).set("x-test-who", as(founder));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: "offering.onramp_late_evidence_not_found",
      title: "Late onramp evidence not found",
      status: 404,
      type: "https://api.vistablox.io/errors/offering.onramp_late_evidence_not_found",
    });
    expect(response.body.trace_id).toBeDefined();
  });
});

describe("authorization: staff with admin_operations and a verified WebAuthn session only", () => {
  const callers: Array<[string, Who | undefined, number, string]> = [
    ["nobody signed in", undefined, 401, "authentication.required"],
    ["a customer", { population: "customer", accountId: "account_customer", adminOperations: false, mfa: true }, 403, "authorization.forbidden"],
    ["a customer holding the admin role by mistake", { population: "customer", accountId: "account_customer", adminOperations: true, mfa: true }, 403, "authorization.forbidden"],
    ["a staff account without admin_operations", { population: "staff_partner", accountId: "account_partner", adminOperations: false, mfa: true }, 403, "authorization.forbidden"],
    ["an admin_operations account without a verified WebAuthn session", { population: "staff_partner", accountId: "account_founder", adminOperations: true, mfa: false }, 403, "authentication.staff_mfa_required"],
  ];

  const routes: Array<[string, (agent: request.Agent) => request.Test]> = [
    ["GET the list", (agent) => agent.get(base)],
    ["POST mark-reviewed", (agent) => agent.post(`${base}/onramp_late_evidence_02/mark-reviewed`)],
  ];

  for (const [routeLabel, send] of routes) {
    it.each(callers)(`${routeLabel} refuses %s and never reaches the repository`, async (_label, who, status, code) => {
      const { app, listLateEvidence, markLateEvidenceReviewed } = buildApp({ rows: [record()] });
      const call = send(request.agent(app));
      const response = await (who === undefined ? call : call.set("x-test-who", as(who)));

      expect(response.status).toBe(status);
      expect(response.body.code).toBe(code);
      expect(listLateEvidence).not.toHaveBeenCalled();
      expect(markLateEvidenceReviewed).not.toHaveBeenCalled();
    });
  }
});

describe("there is nothing else staff can do to an entry", () => {
  it.each([
    ["POST", "/onramp_late_evidence_02/resolve"],
    ["POST", "/onramp_late_evidence_02/hold"],
    ["POST", "/onramp_late_evidence_02/reinstate"],
    ["POST", "/onramp_late_evidence_02/refund"],
    ["POST", "/onramp_late_evidence_02/release"],
    ["POST", "/"],
    ["PATCH", "/onramp_late_evidence_02"],
    ["PUT", "/onramp_late_evidence_02"],
    ["DELETE", "/onramp_late_evidence_02"],
    ["GET", "/onramp_late_evidence_02"],
  ])("%s %s is not a route", async (method, path) => {
    const { app, markLateEvidenceReviewed, listLateEvidence } = buildApp();

    const response = await request(app)[method.toLowerCase() as "post" | "patch" | "put" | "delete" | "get"](`${base}${path}`).set("x-test-who", as(founder));

    expect(response.status).toBe(404);
    expect(markLateEvidenceReviewed).not.toHaveBeenCalled();
    expect(listLateEvidence).not.toHaveBeenCalled();
  });
});
