import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { MalwareScanner } from "../src/infrastructure/antivirus/clamav-scanner.js";
import type { WritableDisclosureDocumentStore } from "../src/modules/offering/application/disclosure-document-store.js";
import {
  MAX_OFFERING_DOCUMENT_BYTES,
  UploadOfferingDocumentService,
  asciiMetadataValue,
} from "../src/modules/offering/application/upload-offering-document.service.js";
import type { OfferingDocumentRepository } from "../src/modules/offering/repository/offering-document.repository.js";

const now = new Date("2026-11-13T10:00:00.000Z");
const offeringId = "offering_01M7AGKPB4F22YKF7Y3SJFB4W1";

function repository(overrides: Partial<OfferingDocumentRepository> = {}): OfferingDocumentRepository {
  return {
    offeringExists: vi.fn().mockResolvedValue(true),
    createOfferingDocument: vi.fn().mockResolvedValue(undefined),
    listOfferingDocuments: vi.fn().mockResolvedValue([]),
    findOfferingDocumentByRef: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function store(overrides: Partial<WritableDisclosureDocumentStore> = {}): WritableDisclosureDocumentStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function scanner(result: "clean" | "infected" | Error = "clean"): MalwareScanner {
  return { scan: vi.fn(async () => { if (result instanceof Error) throw result; return result; }) };
}

function body(...chunks: string[]): AsyncIterable<Buffer> {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

function input(overrides: Partial<Parameters<UploadOfferingDocumentService["execute"]>[0]> = {}) {
  return {
    offeringId,
    documentType: "final_terms_sheet",
    body: body("%PDF-1.4 ", "final terms"),
    contentType: "application/pdf",
    originalFilename: "Final terms – v1.pdf",
    actorAccountId: "account_staff",
    traceId: "req_01",
    ...overrides,
  };
}

describe("UploadOfferingDocumentService", () => {
  it("scans, stores under the offering's object key, records the metadata row and reports the upload", async () => {
    const documents = repository();
    const objects = store();
    const malware = scanner("clean");
    const service = new UploadOfferingDocumentService(documents, objects, malware, () => now);

    const result = await service.execute(input());

    const bytes = Buffer.from("%PDF-1.4 final terms");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    expect(result.data).toMatchObject({
      document_type: "final_terms_sheet",
      content_type: "application/pdf",
      size_bytes: bytes.length,
      sha256_checksum: checksum,
      original_filename: "Final terms – v1.pdf",
      uploaded_at: now.toISOString(),
    });
    expect(result.data.document_id).toMatch(/^doc_[a-f0-9]{32}$/);
    expect(result.data.document_ref).toBe(`offerings/${offeringId}/${result.data.document_id}`);

    expect(malware.scan).toHaveBeenCalledWith(bytes);
    expect(objects.put).toHaveBeenCalledWith({
      documentReference: result.data.document_ref,
      body: bytes,
      contentType: "application/pdf",
      metadata: { "original-filename": "Final terms  v1.pdf", sha256: checksum, "document-type": "final_terms_sheet" },
    });
    expect(documents.createOfferingDocument).toHaveBeenCalledWith({
      documentId: result.data.document_id,
      offeringId,
      documentType: "final_terms_sheet",
      documentRef: result.data.document_ref,
      contentType: "application/pdf",
      sizeBytes: bytes.length,
      sha256Checksum: checksum,
      originalFilename: "Final terms – v1.pdf",
      actorAccountId: "account_staff",
      traceId: "req_01",
      uploadedAt: now,
    });
    expect(objects.delete).not.toHaveBeenCalled();
  });

  it("caps the stored original filename at 255 characters", async () => {
    const documents = repository();
    const service = new UploadOfferingDocumentService(documents, store(), scanner(), () => now);
    const result = await service.execute(input({ originalFilename: `${"a".repeat(300)}.pdf` }));
    expect(result.data.original_filename).toBe("a".repeat(255));
    expect(documents.createOfferingDocument).toHaveBeenCalledWith(expect.objectContaining({ originalFilename: "a".repeat(255) }));
  });

  it("rejects a document type outside the disclosure pack before reading the body", async () => {
    const documents = repository();
    const objects = store();
    const service = new UploadOfferingDocumentService(documents, objects, scanner(), () => now);
    await expect(service.execute(input({ documentType: "marketing_flyer" }))).rejects.toMatchObject({
      code: "offering.document_type_unsupported",
      status: 422,
    });
    expect(documents.offeringExists).not.toHaveBeenCalled();
    expect(objects.put).not.toHaveBeenCalled();
  });

  it("rejects a content type outside the allowlist", async () => {
    const objects = store();
    const service = new UploadOfferingDocumentService(repository(), objects, scanner(), () => now);
    await expect(service.execute(input({ contentType: "text/html" }))).rejects.toMatchObject({
      code: "offering.document_mime_unsupported",
      status: 422,
    });
    expect(objects.put).not.toHaveBeenCalled();
  });

  it("404s for an unknown offering", async () => {
    const objects = store();
    const service = new UploadOfferingDocumentService(repository({ offeringExists: vi.fn().mockResolvedValue(false) }), objects, scanner(), () => now);
    await expect(service.execute(input())).rejects.toMatchObject({ code: "offering.not_found", status: 404 });
    expect(objects.put).not.toHaveBeenCalled();
  });

  it("stops reading at 100 MB with a 413", async () => {
    const objects = store();
    const malware = scanner();
    const service = new UploadOfferingDocumentService(repository(), objects, malware, () => now);
    const chunk = Buffer.alloc(1024 * 1024);
    async function* oversized() {
      for (let sent = 0; sent <= MAX_OFFERING_DOCUMENT_BYTES; sent += chunk.length) yield chunk;
    }
    await expect(service.execute(input({ body: oversized() }))).rejects.toMatchObject({
      code: "offering.document_too_large",
      status: 413,
    });
    expect(malware.scan).not.toHaveBeenCalled();
    expect(objects.put).not.toHaveBeenCalled();
  });

  it("rejects an empty body", async () => {
    const service = new UploadOfferingDocumentService(repository(), store(), scanner(), () => now);
    await expect(service.execute(input({ body: body() }))).rejects.toMatchObject({ code: "offering.document_empty", status: 422 });
  });

  it("fails closed with a 503 when the scanner is unavailable, storing nothing", async () => {
    const objects = store();
    const documents = repository();
    const service = new UploadOfferingDocumentService(documents, objects, scanner(new Error("clamd down")), () => now);
    await expect(service.execute(input())).rejects.toMatchObject({
      code: "offering.document_scanner_unavailable",
      status: 503,
    });
    expect(objects.put).not.toHaveBeenCalled();
    expect(documents.createOfferingDocument).not.toHaveBeenCalled();
  });

  it("rejects an infected document with a 422, storing nothing", async () => {
    const objects = store();
    const documents = repository();
    const service = new UploadOfferingDocumentService(documents, objects, scanner("infected"), () => now);
    await expect(service.execute(input())).rejects.toMatchObject({
      code: "offering.document_malware_detected",
      status: 422,
    });
    expect(objects.put).not.toHaveBeenCalled();
    expect(documents.createOfferingDocument).not.toHaveBeenCalled();
  });

  it("removes the stored object again when the metadata row cannot be written", async () => {
    const objects = store();
    const failure = new Error("database down");
    const documents = repository({ createOfferingDocument: vi.fn().mockRejectedValue(failure) });
    const service = new UploadOfferingDocumentService(documents, objects, scanner(), () => now);

    await expect(service.execute(input())).rejects.toBe(failure);

    expect(objects.put).toHaveBeenCalledOnce();
    const putInput = vi.mocked(objects.put).mock.calls[0]![0];
    expect(objects.delete).toHaveBeenCalledWith(putInput.documentReference);
  });

  it("propagates a storage write failure without touching the database", async () => {
    const documents = repository();
    const objects = store({ put: vi.fn().mockRejectedValue(new Error("minio down")) });
    const service = new UploadOfferingDocumentService(documents, objects, scanner(), () => now);
    await expect(service.execute(input())).rejects.toThrow("minio down");
    expect(documents.createOfferingDocument).not.toHaveBeenCalled();
  });
});

describe("asciiMetadataValue", () => {
  it("keeps printable ASCII, drops the rest, and never returns an empty value", () => {
    expect(asciiMetadataValue("Final terms.pdf")).toBe("Final terms.pdf");
    expect(asciiMetadataValue("Završni uslovi – v1.pdf")).toBe("Zavrsni uslovi  v1.pdf");
    expect(asciiMetadataValue("Условия.pdf")).toBe(".pdf");
    expect(asciiMetadataValue("日本語")).toBe("document");
  });
});
