import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createLatePaymentOperationsRouter } from "../src/modules/offering/api/late-payment-operations.router.js";
import { ListLatePaymentsService } from "../src/modules/offering/application/list-late-payments.service.js";
import type {
  LatePaymentRecord,
  LatePaymentReviewRepository,
} from "../src/modules/offering/repository/onramp-payment.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function record(overrides: Partial<LatePaymentRecord> = {}): LatePaymentRecord {
  return {
    latePaymentId: "late_payment_02",
    reservationId: "reservation_01",
    offeringId: "offering_01",
    accountId: "account_01",
    provider: "coinbase_cdp",
    providerReference: "txn_late",
    reservationStageAtDetection: "lapsed",
    currentReservationStage: "lapsed",
    reservedAmountEur: "1000.00",
    purchaseCurrency: "EURC",
    purchaseAmount: "950.000000",
    coversReservation: true,
    reviewStatus: "pending_review",
    detectedAt: new Date("2026-11-16T10:00:00.000Z"),
    ...overrides,
  };
}

function buildApp(options: { rows?: LatePaymentRecord[]; denyAdminOperations?: boolean } = {}) {
  const listLatePayments = vi.fn().mockResolvedValue(options.rows ?? []);
  const repository: LatePaymentReviewRepository = { listLatePayments };
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = { accountId: "account_ops", providerSessionId: "session_01", population: "staff_partner" };
    next();
  };
  const requireAdminOperations: RequestHandler = (_request, _response, next) => {
    if (options.denyAdminOperations === true) {
      next(new AppError({ code: "authorization.forbidden", title: "Action not permitted", status: 403, detail: "Admin operations role required." }));
      return;
    }
    next();
  };
  const requireStaffWebAuthn: RequestHandler = (_request, _response, next) => next();

  const app = express();
  app.use(requestContext);
  app.use(
    "/internal/v1/offerings/late-payments",
    createLatePaymentOperationsRouter(authenticated, requireAdminOperations, requireStaffWebAuthn, new ListLatePaymentsService(repository)),
  );
  app.use(errorHandler);
  return { app, listLatePayments };
}

describe("GET /internal/v1/offerings/late-payments", () => {
  it("lists held late payments for staff", async () => {
    const { app, listLatePayments } = buildApp({ rows: [record()] });

    const response = await request(app).get("/internal/v1/offerings/late-payments");

    expect(response.status).toBe(200);
    expect(listLatePayments).toHaveBeenCalledWith({ limit: 25 });
    expect(response.body).toEqual({
      data: [
        {
          late_payment_id: "late_payment_02",
          reservation_id: "reservation_01",
          offering_id: "offering_01",
          account_id: "account_01",
          provider: "coinbase_cdp",
          provider_reference: "txn_late",
          reservation_stage_at_detection: "lapsed",
          current_reservation_stage: "lapsed",
          reserved_amount_eur: "1000.00",
          purchase_currency: "EURC",
          purchase_amount: "950.000000",
          covers_reservation: true,
          review_status: "pending_review",
          detected_at: "2026-11-16T10:00:00.000Z",
        },
      ],
      page: { next_cursor: null },
    });
  });

  it("pages with an exclusive after cursor", async () => {
    const { app, listLatePayments } = buildApp({
      rows: [record({ latePaymentId: "late_payment_03" }), record({ latePaymentId: "late_payment_02" })],
    });

    const response = await request(app).get(
      "/internal/v1/offerings/late-payments?limit=1&after=late_payment_04&review_status=pending_review",
    );

    expect(response.status).toBe(200);
    expect(listLatePayments).toHaveBeenCalledWith({ limit: 1, after: "late_payment_04", reviewStatus: "pending_review" });
    expect(response.body.data).toHaveLength(1);
    expect(response.body.page).toEqual({ next_cursor: "late_payment_03" });
  });

  it("rejects an unknown review_status before touching the repository", async () => {
    const { app, listLatePayments } = buildApp();

    const response = await request(app).get("/internal/v1/offerings/late-payments?review_status=refunded");

    expect(response.status).toBe(422);
    expect(response.body.field_errors).toBeDefined();
    expect(listLatePayments).not.toHaveBeenCalled();
  });

  it("never reaches the repository without the admin_operations role", async () => {
    const { app, listLatePayments } = buildApp({ denyAdminOperations: true });

    const response = await request(app).get("/internal/v1/offerings/late-payments");

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("authorization.forbidden");
    expect(listLatePayments).not.toHaveBeenCalled();
  });
});
