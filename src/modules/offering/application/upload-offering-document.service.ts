import { createHash, randomUUID } from "node:crypto";

import type { MalwareScanner } from "../../../infrastructure/antivirus/clamav-scanner.js";
import { objectKey } from "../../../infrastructure/storage/storage-buckets.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { UploadOfferingDocumentResponse } from "../api/offering-operations.schemas.js";
import { disclosureDocumentTypes, type DisclosureDocumentType } from "../domain/disclosure-pack.policy.js";
import type { OfferingDocumentRepository } from "../repository/offering-document.repository.js";
import type { WritableDisclosureDocumentStore } from "./disclosure-document-store.js";

export const MAX_OFFERING_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_ORIGINAL_FILENAME_LENGTH = 255;

/** Same allowlist as intake's case-document upload. */
export const OFFERING_DOCUMENT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const DOCUMENT_TYPES: ReadonlySet<string> = new Set(disclosureDocumentTypes);

/**
 * Staff upload of one disclosure document (AD-130: allowlist, size cap and
 * malware scan before any byte is kept). The object lands in the disclosures
 * bucket under `offerings/{offering_id}/{document_id}` — the key the
 * resulting stored_documents row carries as its `document_ref`, which a
 * later publishDisclosurePack must quote and the existing investor download
 * (`MinioDisclosureDocumentStore.get`) streams unchanged.
 */
export class UploadOfferingDocumentService {
  public constructor(
    private readonly repository: OfferingDocumentRepository,
    private readonly store: WritableDisclosureDocumentStore,
    private readonly scanner: MalwareScanner,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    offeringId: string;
    documentType: string;
    body: AsyncIterable<Buffer | Uint8Array>;
    contentType: string;
    originalFilename: string;
    actorAccountId: string;
    traceId: string;
  }): Promise<UploadOfferingDocumentResponse> {
    if (!DOCUMENT_TYPES.has(input.documentType)) {
      throw new AppError({
        code: "offering.document_type_unsupported",
        title: "Unsupported document type",
        status: 422,
        detail: "X-Document-Type must be one of the disclosure-pack document types.",
      });
    }
    const documentType = input.documentType as DisclosureDocumentType;
    if (!OFFERING_DOCUMENT_CONTENT_TYPES.has(input.contentType)) {
      throw new AppError({
        code: "offering.document_mime_unsupported",
        title: "Unsupported document",
        status: 422,
        detail: "This file type is not supported.",
      });
    }
    if (!(await this.repository.offeringExists(input.offeringId))) {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }

    const chunks: Buffer[] = [];
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of input.body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_OFFERING_DOCUMENT_BYTES) {
        throw new AppError({
          code: "offering.document_too_large",
          title: "Document too large",
          status: 413,
          detail: "Documents must be 100 MB or smaller.",
        });
      }
      chunks.push(bytes);
      hash.update(bytes);
    }
    if (size === 0) {
      throw new AppError({
        code: "offering.document_empty",
        title: "Empty document",
        status: 422,
        detail: "The uploaded document is empty.",
      });
    }
    const body = Buffer.concat(chunks);
    const sha256Checksum = hash.digest("hex");

    let scan: "clean" | "infected";
    try {
      scan = await this.scanner.scan(body);
    } catch {
      throw new AppError({
        code: "offering.document_scanner_unavailable",
        title: "Document scanner unavailable",
        status: 503,
        detail: "The document cannot be accepted while malware scanning is unavailable.",
      });
    }
    if (scan === "infected") {
      throw new AppError({
        code: "offering.document_malware_detected",
        title: "Document rejected",
        status: 422,
        detail: "The uploaded document was rejected by malware scanning.",
      });
    }

    const documentId = `doc_${randomUUID().replaceAll("-", "")}`;
    const documentRef = objectKey({ area: "offerings", subjectId: input.offeringId, documentId });
    const originalFilename = input.originalFilename.slice(0, MAX_ORIGINAL_FILENAME_LENGTH);
    const uploadedAt = this.clock();

    await this.store.put({
      documentReference: documentRef,
      body,
      contentType: input.contentType,
      metadata: {
        "original-filename": asciiMetadataValue(originalFilename),
        sha256: sha256Checksum,
        "document-type": documentType,
      },
    });
    try {
      await this.repository.createOfferingDocument({
        documentId,
        offeringId: input.offeringId,
        documentType,
        documentRef,
        contentType: input.contentType,
        sizeBytes: size,
        sha256Checksum,
        originalFilename,
        actorAccountId: input.actorAccountId,
        traceId: input.traceId,
        uploadedAt,
      });
    } catch (error) {
      // No metadata row means nothing can ever reference the object; take it
      // back out rather than leave an orphan behind. Best effort only.
      await this.store.delete(documentRef).catch(() => undefined);
      throw error;
    }

    return {
      data: {
        document_id: documentId,
        document_type: documentType,
        document_ref: documentRef,
        content_type: input.contentType,
        size_bytes: size,
        sha256_checksum: sha256Checksum,
        original_filename: originalFilename,
        uploaded_at: uploadedAt.toISOString(),
      },
    };
  }
}

/**
 * S3 user metadata is sent as HTTP headers, which Node refuses to emit for
 * characters outside Latin-1 and MinIO does not round-trip reliably beyond
 * ASCII. The exact name is kept on the stored_documents row; this copy only
 * feeds the investor download's Content-Disposition, which sanitises again.
 */
export function asciiMetadataValue(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
  return ascii.length === 0 ? "document" : ascii;
}
