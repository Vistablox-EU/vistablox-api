import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { DisclosureDocumentStore } from "../src/modules/offering/application/disclosure-document-store.js";
import { GetOfferingDocumentService } from "../src/modules/offering/application/get-offering-document.service.js";
import type {
  OfferingDocumentListItem,
  OfferingDocumentRepository,
} from "../src/modules/offering/repository/offering-document.repository.js";

const uploadedAt = new Date("2026-11-13T10:00:00.000Z");
const record: OfferingDocumentListItem = {
  documentId: "doc_01",
  offeringId: "offering_01",
  documentType: "final_terms_sheet",
  documentRef: "offerings/offering_01/doc_01",
  contentType: "application/pdf",
  sizeBytes: 20,
  sha256Checksum: "0".repeat(64),
  originalFilename: "Final terms.pdf",
  uploadedAt,
  publishedInPackId: "pack_02",
};

function repository(overrides: Partial<OfferingDocumentRepository> = {}): OfferingDocumentRepository {
  return {
    offeringExists: vi.fn().mockResolvedValue(true),
    createOfferingDocument: vi.fn(),
    listOfferingDocuments: vi.fn().mockResolvedValue([record, { ...record, documentId: "doc_00", documentRef: "offerings/offering_01/doc_00", originalFilename: null, publishedInPackId: null }]),
    findOfferingDocumentByRef: vi.fn().mockResolvedValue(record),
    ...overrides,
  };
}

function store(result: Awaited<ReturnType<DisclosureDocumentStore["get"]>>): DisclosureDocumentStore {
  return { get: vi.fn().mockResolvedValue(result) };
}

describe("GetOfferingDocumentService.list", () => {
  it("maps the offering's uploads to the wire shape, passing the type filter through", async () => {
    const documents = repository();
    const service = new GetOfferingDocumentService(documents, store(null));

    const result = await service.list({ offeringId: "offering_01", documentType: "final_terms_sheet" });

    expect(result).toEqual({
      data: [
        {
          document_id: "doc_01",
          document_type: "final_terms_sheet",
          document_ref: "offerings/offering_01/doc_01",
          content_type: "application/pdf",
          size_bytes: 20,
          original_filename: "Final terms.pdf",
          uploaded_at: uploadedAt.toISOString(),
          published_in_pack_id: "pack_02",
        },
        {
          document_id: "doc_00",
          document_type: "final_terms_sheet",
          document_ref: "offerings/offering_01/doc_00",
          content_type: "application/pdf",
          size_bytes: 20,
          original_filename: "document",
          uploaded_at: uploadedAt.toISOString(),
          published_in_pack_id: null,
        },
      ],
    });
    expect(documents.listOfferingDocuments).toHaveBeenCalledWith({ offeringId: "offering_01", documentType: "final_terms_sheet" });
  });

  it("omits the type filter when none was given", async () => {
    const documents = repository();
    await new GetOfferingDocumentService(documents, store(null)).list({ offeringId: "offering_01" });
    expect(documents.listOfferingDocuments).toHaveBeenCalledWith({ offeringId: "offering_01" });
  });

  it("404s for an unknown offering without listing", async () => {
    const documents = repository({ offeringExists: vi.fn().mockResolvedValue(false) });
    await expect(new GetOfferingDocumentService(documents, store(null)).list({ offeringId: "offering_missing" })).rejects.toMatchObject({
      code: "offering.not_found",
      status: 404,
    });
    expect(documents.listOfferingDocuments).not.toHaveBeenCalled();
  });
});

describe("GetOfferingDocumentService.download", () => {
  it("streams an accepted upload with the metadata row's content type, length and name", async () => {
    const body = Readable.from(Buffer.from("regulated disclosure"));
    const objects = store({ body, contentType: "application/octet-stream", contentLength: 999, fileName: "metadata-name.pdf" });
    const result = await new GetOfferingDocumentService(repository(), objects).download({
      offeringId: "offering_01",
      documentRef: "offerings/offering_01/doc_01",
    });
    expect(result).toEqual({ body, contentType: "application/pdf", contentLength: 20, fileName: "Final terms.pdf" });
    expect(objects.get).toHaveBeenCalledWith("offerings/offering_01/doc_01");
  });

  it("404s a ref that is not one of the offering's accepted uploads without touching storage", async () => {
    const objects = store(null);
    const service = new GetOfferingDocumentService(repository({ findOfferingDocumentByRef: vi.fn().mockResolvedValue(null) }), objects);
    await expect(service.download({ offeringId: "offering_01", documentRef: "offerings/offering_02/doc_99" })).rejects.toMatchObject({
      code: "offering.document_not_found",
      status: 404,
    });
    expect(objects.get).not.toHaveBeenCalled();
  });

  it("reports a 503 when the metadata row exists but the object is gone", async () => {
    const service = new GetOfferingDocumentService(repository(), store(null));
    await expect(service.download({ offeringId: "offering_01", documentRef: "offerings/offering_01/doc_01" })).rejects.toMatchObject({
      code: "offering.document_storage_inconsistent",
      status: 503,
    });
  });
});
