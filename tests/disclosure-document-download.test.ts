import { Readable } from "node:stream";

import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createInvestorOfferingRouter } from "../src/modules/offering/api/offering.router.js";
import { DownloadDisclosureDocumentService } from "../src/modules/offering/application/download-disclosure-document.service.js";
import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import type { DisclosureDocumentStore } from "../src/modules/offering/application/disclosure-document-store.js";
import type { DisclosureDocumentRepository } from "../src/modules/offering/repository/disclosure-document.repository.js";
import type { OfferingRepository } from "../src/modules/offering/repository/offering.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function documentRepository(
  record: Awaited<ReturnType<DisclosureDocumentRepository["getAccessibleDocument"]>>,
): DisclosureDocumentRepository {
  return { getAccessibleDocument: vi.fn().mockResolvedValue(record) };
}

function documentStore(
  record: Awaited<ReturnType<DisclosureDocumentStore["get"]>>,
): DisclosureDocumentStore {
  return { get: vi.fn().mockResolvedValue(record) };
}

const unusedOfferingRepository: OfferingRepository = {
  listPublic: vi.fn().mockResolvedValue([]),
  getInvestorDetail: vi.fn().mockResolvedValue(null),
};

function appFor(input: {
  population: "customer" | "staff_partner";
  service: DownloadDisclosureDocumentService;
}) {
  const app = express();
  const authenticated: RequestHandler = (_request, response, next) => {
    response.locals.authContext = {
      accountId: "account_01",
      providerSessionId: "session_01",
      population: input.population,
    };
    next();
  };
  app.use(requestContext);
  app.use(
    "/v1/offerings",
    createInvestorOfferingRouter(
      authenticated,
      new GetInvestorOfferingService(unusedOfferingRepository),
      input.service,
    ),
  );
  app.use(errorHandler);
  return app;
}

describe("disclosure document download", () => {
  it("streams an authorized document through the API with private download headers", async () => {
    const repository = documentRepository({
      documentReference: "offering_01/pack_2/kiis.pdf",
      documentType: "ecsp_kiis",
      disclosurePackVersion: 2,
    });
    const store = documentStore({
      body: Readable.from(Buffer.from("regulated disclosure")),
      contentType: "application/pdf",
      contentLength: 20,
      fileName: "KIIS 2026.pdf",
    });
    const response = await request(
      appFor({
        population: "customer",
        service: new DownloadDisclosureDocumentService(repository, store),
      }),
    ).get("/v1/offerings/offering_01/documents/document_01/download");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="KIIS-2026.pdf"',
    );
    expect(response.body).toEqual(Buffer.from("regulated disclosure"));
    expect(repository.getAccessibleDocument).toHaveBeenCalledWith({
      accountId: "account_01",
      offeringId: "offering_01",
      documentId: "document_01",
    });
    expect(store.get).toHaveBeenCalledWith("offering_01/pack_2/kiis.pdf");
  });

  it("does not query storage when the document is outside the account's scope", async () => {
    const repository = documentRepository(null);
    const store = documentStore(null);
    const service = new DownloadDisclosureDocumentService(repository, store);

    await expect(
      service.execute({
        accountId: "account_01",
        offeringId: "offering_01",
        documentId: "historical_document",
      }),
    ).rejects.toMatchObject({ code: "offering.document_not_found", status: 404 });
    expect(store.get).not.toHaveBeenCalled();
  });

  it("maps a missing stored object to a provider-neutral retryable error", async () => {
    const service = new DownloadDisclosureDocumentService(
      documentRepository({
        documentReference: "missing-object",
        documentType: "final_terms_sheet",
        disclosurePackVersion: 3,
      }),
      documentStore(null),
    );

    await expect(
      service.execute({
        accountId: "account_01",
        offeringId: "offering_01",
        documentId: "document_01",
      }),
    ).rejects.toMatchObject({
      code: "offering.document_storage_inconsistent",
      status: 503,
    });
  });

  it("keeps the download surface customer-only", async () => {
    const service = new DownloadDisclosureDocumentService(
      documentRepository(null),
      documentStore(null),
    );
    const response = await request(
      appFor({ population: "staff_partner", service }),
    ).get("/v1/offerings/offering_01/documents/document_01/download");

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      code: "authorization.forbidden",
      status: 403,
    });
  });
});
