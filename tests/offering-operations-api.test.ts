import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOfferingOperationsRouter } from "../src/modules/offering/api/offering-operations.router.js";
import { FinalizeOfferingService } from "../src/modules/offering/application/finalize-offering.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import type { FinalizeOfferingRepository } from "../src/modules/offering/repository/finalize-offering.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function buildApp(options?: {
  repository?: Partial<FinalizeOfferingRepository>;
  denyAdminOperations?: boolean;
}) {
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "account_founder",
      providerSessionId: "session_01",
      population: "staff_partner",
    };
    next();
  };
  const requireAdminOperations: RequestHandler = (_request, response, next) => {
    if (options?.denyAdminOperations === true) {
      next(
        new AppError({
          code: "authorization.forbidden",
          title: "Action not permitted",
          status: 403,
          detail: "Admin operations role required.",
        }),
      );
      return;
    }
    next();
  };
  const requireStaffWebAuthn: RequestHandler = (_request, _response, next) => next();

  const repository: FinalizeOfferingRepository = {
    finalizeOffering: vi.fn().mockResolvedValue({
      finalized: {
        offeringId: "offering_01",
        finalOfferingPublishedAt: new Date("2026-09-02T12:00:00.000Z"),
        positionsCreated: 3,
        reservationsCancelled: 1,
      },
      conflict: null,
    }),
    ...options?.repository,
  };

  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/internal/v1/offerings",
    createOfferingOperationsRouter(
      authenticated,
      requireAdminOperations,
      requireStaffWebAuthn,
      new FinalizeOfferingService(repository, () => new Date("2026-09-02T12:00:00.000Z")),
    ),
  );
  app.use(errorHandler);
  return { app, repository };
}

describe("POST /internal/v1/offerings/:offering_id/finalize", () => {
  it("finalizes an eligible offering", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "Target reached, proceeding to tokenization." });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        offering_id: "offering_01",
        status: "final_offering",
        final_offering_published_at: "2026-09-02T12:00:00.000Z",
        positions_created: 3,
        reservations_cancelled: 1,
      },
    });
    expect(repository.finalizeOffering).toHaveBeenCalledWith(
      expect.objectContaining({
        offeringId: "offering_01",
        accountId: "account_founder",
        founderReviewNotes: "Target reached, proceeding to tokenization.",
      }),
    );
  });

  it("rejects an empty founder_review_notes before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "" });

    expect(response.status).toBe(422);
    expect(repository.finalizeOffering).not.toHaveBeenCalled();
  });

  it("reports the target-not-reached conflict as a 409", async () => {
    const { app } = buildApp({
      repository: {
        finalizeOffering: vi.fn().mockResolvedValue({ finalized: null, conflict: "target_not_reached" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "Trying early." });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("offering.finalization_target_not_reached");
  });

  it("never reaches the service without the admin_operations role", async () => {
    const { app, repository } = buildApp({ denyAdminOperations: true });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "notes" });

    expect(response.status).toBe(403);
    expect(repository.finalizeOffering).not.toHaveBeenCalled();
  });
});
