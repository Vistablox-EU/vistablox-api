import { Readable } from "node:stream";

import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createOfferingOperationsRouter, decodeOriginalFilename } from "../src/modules/offering/api/offering-operations.router.js";
import { ClassifyMaterialityService } from "../src/modules/offering/application/classify-materiality.service.js";
import { FinalizeOfferingService } from "../src/modules/offering/application/finalize-offering.service.js";
import type { GetOfferingDocumentService } from "../src/modules/offering/application/get-offering-document.service.js";
import { PublishDisclosurePackService } from "../src/modules/offering/application/publish-disclosure-pack.service.js";
import type { UploadOfferingDocumentService } from "../src/modules/offering/application/upload-offering-document.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { createIdempotencyMiddleware } from "../src/shared/http/idempotency.js";
import type { IdempotencyStore, StoredIdempotentResponse } from "../src/infrastructure/idempotency/idempotency-store.js";
import type { DisclosurePackRepository } from "../src/modules/offering/repository/disclosure-pack.repository.js";
import type { FinalizeOfferingRepository } from "../src/modules/offering/repository/finalize-offering.repository.js";
import type { MaterialityRepository } from "../src/modules/offering/repository/materiality.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

type Repository = FinalizeOfferingRepository & MaterialityRepository & DisclosurePackRepository;

function buildApp(options?: {
  repository?: Partial<Repository>;
  denyAdminOperations?: boolean;
  requireFinalizeIdempotency?: RequestHandler;
  documents?: { upload?: Partial<UploadOfferingDocumentService>; read?: Partial<GetOfferingDocumentService> };
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
      options?.requireFinalizeIdempotency,
      options?.documents === undefined
        ? undefined
        : {
            upload: { execute: vi.fn(), ...options.documents.upload } as unknown as UploadOfferingDocumentService,
            read: { list: vi.fn(), download: vi.fn(), ...options.documents.read } as unknown as GetOfferingDocumentService,
          },
    ),
  );
  app.use(errorHandler);
  return { app, repository };
}

const uploadedDocument = {
  data: {
    document_id: "doc_0123456789abcdef0123456789abcdef",
    document_type: "final_terms_sheet" as const,
    document_ref: "offerings/offering_01/doc_0123456789abcdef0123456789abcdef",
    content_type: "application/pdf",
    size_bytes: 20,
    sha256_checksum: "a".repeat(64),
    original_filename: "Final terms.pdf",
    uploaded_at: "2026-11-13T10:00:00.000Z",
  },
};

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

  it("rejects a document_ref that is not an accepted upload with a 422 whose field_errors name the bad refs", async () => {
    const { app } = buildApp({
      repository: {
        publishDisclosurePack: vi.fn().mockResolvedValue({
          published: null,
          conflict: "unknown_document_refs",
          unknownDocumentRefs: ["documents/never-uploaded.pdf"],
        }),
      },
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/disclosure-packs")
      .send({
        documents: [
          { document_type: "ecsp_kiis", document_ref: "offerings/offering_01/doc_ok" },
          { document_type: "final_terms_sheet", document_ref: "documents/never-uploaded.pdf" },
        ],
      });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: "offering.disclosure_document_unknown",
      status: 422,
      field_errors: [
        {
          field: "documents.1.document_ref",
          code: "offering.disclosure_document_unknown",
          message: '"documents/never-uploaded.pdf" is not an accepted upload of this offering.',
        },
      ],
    });
    expect(response.body.trace_id).toEqual(expect.any(String));
  });
});

describe("POST /internal/v1/offerings/:offering_id/documents", () => {
  it("is not mounted when document storage is not configured", async () => {
    const { app } = buildApp();
    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/documents")
      .set("Content-Type", "application/pdf")
      .send(Buffer.from("%PDF-1.4"));
    expect(response.status).toBe(404);
  });

  it("hands the raw body and the describing headers to the upload service and reports the stored document", async () => {
    const execute = vi.fn(async (input: { body: AsyncIterable<Buffer | Uint8Array> }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("%PDF-1.4 final terms");
      return uploadedDocument;
    });
    const { app } = buildApp({ documents: { upload: { execute } } });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/documents")
      .set("Content-Type", "application/pdf; charset=binary")
      .set("X-Document-Type", " final_terms_sheet ")
      .set("X-Original-Filename", encodeURIComponent("Završni uslovi – v1.pdf"))
      .send(Buffer.from("%PDF-1.4 final terms"));

    expect(response.status).toBe(201);
    expect(response.body).toEqual(uploadedDocument);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        offeringId: "offering_01",
        documentType: "final_terms_sheet",
        contentType: "application/pdf",
        originalFilename: "Završni uslovi – v1.pdf",
        actorAccountId: "account_founder",
        traceId: expect.any(String),
      }),
    );
  });

  it("takes a filename without percent-encoding verbatim and falls back to the raw header when decoding fails", async () => {
    const execute = vi.fn().mockResolvedValue(uploadedDocument);
    const { app } = buildApp({ documents: { upload: { execute } } });

    await request(app)
      .post("/internal/v1/offerings/offering_01/documents")
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "ecsp_kiis")
      .set("X-Original-Filename", "kiis 2026.pdf")
      .send(Buffer.from("x"));
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ originalFilename: "kiis 2026.pdf" }));

    await request(app)
      .post("/internal/v1/offerings/offering_01/documents")
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "ecsp_kiis")
      .set("X-Original-Filename", "100%-complete.pdf")
      .send(Buffer.from("x"));
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ originalFilename: "100%-complete.pdf" }));

    await request(app)
      .post("/internal/v1/offerings/offering_01/documents")
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "ecsp_kiis")
      .send(Buffer.from("x"));
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ originalFilename: "document", contentType: "application/pdf" }));
  });

  it("surfaces the service's rejections in the documented envelope", async () => {
    const { app } = buildApp({
      documents: {
        upload: {
          execute: vi.fn().mockRejectedValue(
            new AppError({ code: "offering.document_type_unsupported", title: "Unsupported document type", status: 422, detail: "nope" }),
          ),
        },
      },
    });
    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/documents")
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "marketing_flyer")
      .send(Buffer.from("x"));
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: "offering.document_type_unsupported", status: 422, title: "Unsupported document type" });
  });

  it("never reaches the service without the admin_operations role", async () => {
    const execute = vi.fn();
    const { app } = buildApp({ denyAdminOperations: true, documents: { upload: { execute } } });
    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/documents")
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "ecsp_kiis")
      .send(Buffer.from("x"));
    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("decodeOriginalFilename", () => {
  it("decodes, falls back, defaults and caps", () => {
    expect(decodeOriginalFilename(undefined)).toBe("document");
    expect(decodeOriginalFilename("   ")).toBe("document");
    expect(decodeOriginalFilename("plain name.pdf")).toBe("plain name.pdf");
    expect(decodeOriginalFilename("Zavr%C5%A1ni%20uslovi.pdf")).toBe("Završni uslovi.pdf");
    expect(decodeOriginalFilename("100%-done.pdf")).toBe("100%-done.pdf");
    expect(decodeOriginalFilename("%ZZ")).toBe("%ZZ");
    expect(decodeOriginalFilename(`${"x".repeat(300)}.pdf`)).toHaveLength(255);
  });
});

describe("GET /internal/v1/offerings/:offering_id/documents", () => {
  const listed = {
    data: [
      {
        document_id: "doc_01",
        document_type: "final_terms_sheet",
        document_ref: "offerings/offering_01/doc_01",
        content_type: "application/pdf",
        size_bytes: 20,
        original_filename: "Final terms.pdf",
        uploaded_at: "2026-11-13T10:00:00.000Z",
        published_in_pack_id: "pack_02",
      },
      {
        document_id: "doc_00",
        document_type: "ecsp_kiis",
        document_ref: "offerings/offering_01/doc_00",
        content_type: "application/pdf",
        size_bytes: 10,
        original_filename: "kiis.pdf",
        uploaded_at: "2026-11-12T10:00:00.000Z",
        published_in_pack_id: null,
      },
    ],
  };

  it("lists the offering's uploads, passing an optional document_type filter through", async () => {
    const list = vi.fn().mockResolvedValue(listed);
    const { app } = buildApp({ documents: { read: { list } } });

    const all = await request(app).get("/internal/v1/offerings/offering_01/documents");
    expect(all.status).toBe(200);
    expect(all.body).toEqual(listed);
    expect(list).toHaveBeenLastCalledWith({ offeringId: "offering_01" });

    const filtered = await request(app).get("/internal/v1/offerings/offering_01/documents?document_type=final_terms_sheet");
    expect(filtered.status).toBe(200);
    expect(list).toHaveBeenLastCalledWith({ offeringId: "offering_01", documentType: "final_terms_sheet" });
  });

  it("rejects a document_type outside the disclosure pack before touching the service", async () => {
    const list = vi.fn();
    const { app } = buildApp({ documents: { read: { list } } });
    const response = await request(app).get("/internal/v1/offerings/offering_01/documents?document_type=marketing_flyer");
    expect(response.status).toBe(422);
    expect(list).not.toHaveBeenCalled();
  });

  it("streams one document by document_ref with private download headers", async () => {
    const download = vi.fn().mockResolvedValue({
      body: Readable.from(Buffer.from("regulated disclosure")),
      contentType: "application/pdf",
      contentLength: 20,
      fileName: "Final terms – v1.pdf",
    });
    const { app } = buildApp({ documents: { read: { download } } });

    const response = await request(app)
      .get("/internal/v1/offerings/offering_01/documents")
      .query({ document_ref: "offerings/offering_01/doc_01" })
      .buffer(true)
      .parse((message, callback) => {
        const chunks: Buffer[] = [];
        message.on("data", (chunk: Buffer) => chunks.push(chunk));
        message.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-length"]).toBe("20");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-disposition"]).toBe('inline; filename="Final-terms-v1.pdf"');
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toEqual(Buffer.from("regulated disclosure"));
    expect(download).toHaveBeenCalledWith({ offeringId: "offering_01", documentRef: "offerings/offering_01/doc_01" });
  });

  it("reports a 404 for a ref that is not one of the offering's uploads", async () => {
    const { app } = buildApp({
      documents: {
        read: {
          download: vi.fn().mockRejectedValue(
            new AppError({ code: "offering.document_not_found", title: "Disclosure document not found", status: 404, detail: "nope" }),
          ),
        },
      },
    });
    const response = await request(app)
      .get("/internal/v1/offerings/offering_01/documents")
      .query({ document_ref: "offerings/offering_02/doc_99" });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: "offering.document_not_found", status: 404 });
  });

  it("never reaches the service without the admin_operations role", async () => {
    const list = vi.fn();
    const { app } = buildApp({ denyAdminOperations: true, documents: { read: { list } } });
    const response = await request(app).get("/internal/v1/offerings/offering_01/documents");
    expect(response.status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});

function memoryIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, StoredIdempotentResponse>();
  return {
    find: vi.fn(async (idempotencyKey: string, endpoint: string) => {
      return rows.get(`${idempotencyKey}:${endpoint}`) ?? null;
    }),
    save: vi.fn(async (input) => {
      const key = `${input.idempotencyKey}:${input.endpoint}`;
      const existing = rows.get(key);
      if (existing !== undefined) return existing;
      const saved = {
        requestBodyHash: input.requestBodyHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
      };
      rows.set(key, saved);
      return saved;
    }),
  };
}

describe("POST /internal/v1/offerings/:offering_id/finalize — idempotency", () => {
  it("requires the Idempotency-Key on the finalization-batch action", async () => {
    const store = memoryIdempotencyStore();
    const { app, repository } = buildApp({
      requireFinalizeIdempotency: createIdempotencyMiddleware(store, "offering.finalize"),
    });

    const response = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .send({ founder_review_notes: "Target reached." });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("idempotency.key_required");
    expect(repository.publishFinalOfferingTerms).not.toHaveBeenCalled();
  });

  it("replays the cached finalize response without re-running the service", async () => {
    const store = memoryIdempotencyStore();
    const { app, repository } = buildApp({
      requireFinalizeIdempotency: createIdempotencyMiddleware(store, "offering.finalize"),
    });

    const first = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .set("Idempotency-Key", "finalize-key-1")
      .send({ founder_review_notes: "Target reached." });
    const replay = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .set("Idempotency-Key", "finalize-key-1")
      .send({ founder_review_notes: "Target reached." });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(repository.publishFinalOfferingTerms).toHaveBeenCalledTimes(1);
  });

  it("rejects the same finalize key with a different body as a 409", async () => {
    const store = memoryIdempotencyStore();
    const { app } = buildApp({
      requireFinalizeIdempotency: createIdempotencyMiddleware(store, "offering.finalize"),
    });

    await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .set("Idempotency-Key", "finalize-key-1")
      .send({ founder_review_notes: "Target reached." });
    const conflict = await request(app)
      .post("/internal/v1/offerings/offering_01/finalize")
      .set("Idempotency-Key", "finalize-key-1")
      .send({ founder_review_notes: "Different notes." });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("idempotency.body_mismatch");
  });
});
