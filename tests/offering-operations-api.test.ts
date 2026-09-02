import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOfferingOperationsRouter } from "../src/modules/offering/api/offering-operations.router.js";
import { ClassifyMaterialityService } from "../src/modules/offering/application/classify-materiality.service.js";
import { FinalizeOfferingService } from "../src/modules/offering/application/finalize-offering.service.js";
import { PublishDisclosurePackService } from "../src/modules/offering/application/publish-disclosure-pack.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import type { DisclosurePackRepository } from "../src/modules/offering/repository/disclosure-pack.repository.js";
import type { FinalizeOfferingRepository } from "../src/modules/offering/repository/finalize-offering.repository.js";
import type { MaterialityRepository } from "../src/modules/offering/repository/materiality.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

type Repository = FinalizeOfferingRepository & MaterialityRepository & DisclosurePackRepository;

function buildApp(options?: {
  repository?: Partial<Repository>;
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

  const repository: Repository = {
    publishFinalOfferingTerms: vi.fn().mockResolvedValue({
      published: {
        offeringId: "offering_01",
        finalOfferingPublishedAt: new Date("2026-09-02T12:00:00.000Z"),
        platformRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
        effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
        reservationsAwaitingReconfirmation: 3,
        reservationsCancelled: 1,
      },
      conflict: null,
    }),
    reconfirmReservation: vi.fn(),
    listOfferingsPendingFinalizationCommit: vi.fn().mockResolvedValue([]),
    commitOfferingFinalization: vi.fn(),
    classifyMateriality: vi.fn().mockResolvedValue({
      classified: {
        materialityRecordId: "materiality_01",
        offeringId: "offering_01",
        classification: "reviewed_material",
        thresholdType: "valuation",
        resetTriggered: true,
        classifiedAt: new Date("2026-09-05T12:00:00.000Z"),
        effectiveRightsEndAt: new Date("2026-09-12T12:00:00.000Z"),
        reservationsReset: 2,
      },
      conflict: null,
    }),
    publishDisclosurePack: vi.fn().mockResolvedValue({
      published: {
        disclosurePackId: "pack_01",
        offeringId: "offering_01",
        version: 2,
        publishedAt: new Date("2026-09-06T12:00:00.000Z"),
        documents: [
          {
            documentId: "document_01",
            documentType: "ecsp_kiis",
            documentRef: "documents/kiis-v2.pdf",
            isCoreReading: true,
          },
        ],
        isComplete: false,
        supersededPackId: "pack_00",
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
      new ClassifyMaterialityService(repository, () => new Date("2026-09-05T12:00:00.000Z")),
      new PublishDisclosurePackService(repository, () => new Date("2026-09-06T12:00:00.000Z")),
    ),
  );
  app.use(errorHandler);
  return { app, repository };
}

describe("POST /internal/v1/offerings/:offering_id/finalize", () => {
  it("publishes final terms for an eligible offering", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "Target reached, proceeding to tokenization." });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        offering_id: "offering_01",
        final_offering_published_at: "2026-09-02T12:00:00.000Z",
        effective_rights_end_at: "2026-09-09T12:00:00.000Z",
        reservations_awaiting_reconfirmation: 3,
        reservations_cancelled: 1,
      },
    });
    expect(repository.publishFinalOfferingTerms).toHaveBeenCalledWith(
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
    expect(repository.publishFinalOfferingTerms).not.toHaveBeenCalled();
  });

  it("reports the target-not-reached conflict as a 409", async () => {
    const { app } = buildApp({
      repository: {
        publishFinalOfferingTerms: vi.fn().mockResolvedValue({ published: null, conflict: "target_not_reached" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "Trying early." });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("offering.finalization_target_not_reached");
  });

  it("reports the already-published conflict as a 409", async () => {
    const { app } = buildApp({
      repository: {
        publishFinalOfferingTerms: vi.fn().mockResolvedValue({ published: null, conflict: "already_published" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "Trying again." });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("offering.finalization_not_available");
  });

  it("reports the disclosure-pack-incomplete conflict as a 409", async () => {
    const { app } = buildApp({
      repository: {
        publishFinalOfferingTerms: vi
          .fn()
          .mockResolvedValue({ published: null, conflict: "disclosure_pack_incomplete" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "Trying without a pack." });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("offering.finalization_disclosure_pack_incomplete");
  });

  it("never reaches the service without the admin_operations role", async () => {
    const { app, repository } = buildApp({ denyAdminOperations: true });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "notes" });

    expect(response.status).toBe(403);
    expect(repository.publishFinalOfferingTerms).not.toHaveBeenCalled();
  });
});

describe("POST /internal/v1/offerings/:offering_id/materiality-records", () => {
  it("records a materiality classification and reports the reset outcome", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/materiality-records")
      .send({
        change_description: "Independent appraisal came in 7% below the disclosed valuation basis.",
        classification: "reviewed_material",
        threshold_type: "valuation",
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      data: {
        materiality_record_id: "materiality_01",
        offering_id: "offering_01",
        classification: "reviewed_material",
        threshold_type: "valuation",
        reset_triggered: true,
        classified_at: "2026-09-05T12:00:00.000Z",
        effective_rights_end_at: "2026-09-12T12:00:00.000Z",
        reservations_reset: 2,
      },
    });
    expect(repository.classifyMateriality).toHaveBeenCalledWith(
      expect.objectContaining({
        offeringId: "offering_01",
        accountId: "account_founder",
        changeDescription: "Independent appraisal came in 7% below the disclosed valuation basis.",
        classification: "reviewed_material",
        thresholdType: "valuation",
      }),
    );
  });

  it("rejects threshold_type on anything other than reviewed_material before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/materiality-records")
      .send({
        change_description: "Change of primary obligor.",
        classification: "per_se_material",
        threshold_type: "valuation",
      });

    expect(response.status).toBe(422);
    expect(response.body.field_errors).toContainEqual(
      expect.objectContaining({ field: "threshold_type" }),
    );
    expect(repository.classifyMateriality).not.toHaveBeenCalled();
  });

  it("rejects an empty change_description before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/materiality-records")
      .send({ change_description: "", classification: "non_material" });

    expect(response.status).toBe(422);
    expect(repository.classifyMateriality).not.toHaveBeenCalled();
  });

  it("reports a 404 for an unknown offering", async () => {
    const { app } = buildApp({
      repository: {
        classifyMateriality: vi.fn().mockResolvedValue({ classified: null, conflict: "offering_not_found" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_missing/materiality-records")
      .send({ change_description: "notes", classification: "non_material" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("offering.not_found");
  });

  it("reports a 409 when the offering has no active reconfirmation window", async () => {
    const { app } = buildApp({
      repository: {
        classifyMateriality: vi
          .fn()
          .mockResolvedValue({ classified: null, conflict: "no_active_reconfirmation_window" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/materiality-records")
      .send({ change_description: "notes", classification: "non_material" });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("offering.materiality_classification_not_available");
  });

  it("never reaches the service without the admin_operations role", async () => {
    const { app, repository } = buildApp({ denyAdminOperations: true });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/materiality-records")
      .send({ change_description: "notes", classification: "non_material" });

    expect(response.status).toBe(403);
    expect(repository.classifyMateriality).not.toHaveBeenCalled();
  });
});

describe("POST /internal/v1/offerings/:offering_id/disclosure-packs", () => {
  it("publishes a new disclosure pack version and reports the outcome", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/disclosure-packs")
      .send({
        documents: [{ document_type: "ecsp_kiis", document_ref: "documents/kiis-v2.pdf" }],
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      data: {
        disclosure_pack_id: "pack_01",
        offering_id: "offering_01",
        version: 2,
        published_at: "2026-09-06T12:00:00.000Z",
        documents: [{ document_id: "document_01", document_type: "ecsp_kiis", is_core_reading: true }],
        is_complete: false,
        superseded_pack_id: "pack_00",
      },
    });
    expect(repository.publishDisclosurePack).toHaveBeenCalledWith(
      expect.objectContaining({
        offeringId: "offering_01",
        accountId: "account_founder",
        documents: [{ documentType: "ecsp_kiis", documentRef: "documents/kiis-v2.pdf" }],
      }),
    );
  });

  it("rejects an empty documents array before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/disclosure-packs")
      .send({ documents: [] });

    expect(response.status).toBe(422);
    expect(repository.publishDisclosurePack).not.toHaveBeenCalled();
  });

  it("rejects a duplicated document_type before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/disclosure-packs")
      .send({
        documents: [
          { document_type: "ecsp_kiis", document_ref: "documents/kiis-v1.pdf" },
          { document_type: "ecsp_kiis", document_ref: "documents/kiis-v2.pdf" },
        ],
      });

    expect(response.status).toBe(422);
    expect(repository.publishDisclosurePack).not.toHaveBeenCalled();
  });

  it("rejects an unknown document_type before touching the repository", async () => {
    const { app, repository } = buildApp();

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/disclosure-packs")
      .send({ documents: [{ document_type: "marketing_flyer", document_ref: "documents/flyer.pdf" }] });

    expect(response.status).toBe(422);
    expect(repository.publishDisclosurePack).not.toHaveBeenCalled();
  });

  it("reports a 404 for an unknown offering", async () => {
    const { app } = buildApp({
      repository: {
        publishDisclosurePack: vi.fn().mockResolvedValue({ published: null, conflict: "offering_not_found" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_missing/disclosure-packs")
      .send({ documents: [{ document_type: "ecsp_kiis", document_ref: "documents/kiis-v1.pdf" }] });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("offering.not_found");
  });

  it("reports a 409 when the offering is not open for a disclosure pack update", async () => {
    const { app } = buildApp({
      repository: {
        publishDisclosurePack: vi.fn().mockResolvedValue({ published: null, conflict: "not_open" }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/disclosure-packs")
      .send({ documents: [{ document_type: "ecsp_kiis", document_ref: "documents/kiis-v1.pdf" }] });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("offering.disclosure_pack_not_available");
  });

  it("never reaches the service without the admin_operations role", async () => {
    const { app, repository } = buildApp({ denyAdminOperations: true });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/disclosure-packs")
      .send({ documents: [{ document_type: "ecsp_kiis", document_ref: "documents/kiis-v1.pdf" }] });

    expect(response.status).toBe(403);
    expect(repository.publishDisclosurePack).not.toHaveBeenCalled();
  });
});
