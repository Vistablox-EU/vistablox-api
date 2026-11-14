import type { Readable } from "node:stream";

import { AppError } from "../../../shared/errors/app-error.js";
import type { ListOfferingDocumentsResponse } from "../api/offering-operations.schemas.js";
import type { DisclosureDocumentType } from "../domain/disclosure-pack.policy.js";
import type { OfferingDocumentRepository } from "../repository/offering-document.repository.js";
import type { DisclosureDocumentStore } from "./disclosure-document-store.js";

export interface OfferingDocumentDownload {
  body: Readable;
  contentType: string;
  contentLength: number;
  fileName: string;
}

/** Staff-side reads of an offering's uploaded disclosure documents. */
export class GetOfferingDocumentService {
  public constructor(
    private readonly repository: OfferingDocumentRepository,
    private readonly store: DisclosureDocumentStore,
  ) {}

  public async list(input: { offeringId: string; documentType?: DisclosureDocumentType }): Promise<ListOfferingDocumentsResponse> {
    if (!(await this.repository.offeringExists(input.offeringId))) throw offeringNotFound();
    const documents = await this.repository.listOfferingDocuments({
      offeringId: input.offeringId,
      ...(input.documentType === undefined ? {} : { documentType: input.documentType }),
    });
    return {
      data: documents.map((document) => ({
        document_id: document.documentId,
        document_type: document.documentType as DisclosureDocumentType,
        document_ref: document.documentRef,
        content_type: document.contentType,
        size_bytes: document.sizeBytes,
        original_filename: document.originalFilename ?? "document",
        uploaded_at: document.uploadedAt.toISOString(),
        published_in_pack_id: document.publishedInPackId,
      })),
    };
  }

  public async download(input: { offeringId: string; documentRef: string }): Promise<OfferingDocumentDownload> {
    const document = await this.repository.findOfferingDocumentByRef(input);
    if (document === null) {
      throw new AppError({
        code: "offering.document_not_found",
        title: "Disclosure document not found",
        status: 404,
        detail: "The requested document is not an accepted upload of this offering.",
      });
    }
    const stored = await this.store.get(document.documentRef);
    if (stored === null) {
      throw new AppError({
        code: "offering.document_storage_inconsistent",
        title: "Disclosure document unavailable",
        status: 503,
        detail: "The disclosure document is temporarily unavailable.",
      });
    }
    return {
      body: stored.body,
      // The metadata row is authoritative; it is what the upload validated.
      contentType: document.contentType,
      contentLength: document.sizeBytes,
      fileName: document.originalFilename ?? stored.fileName ?? document.documentId,
    };
  }
}

function offeringNotFound(): AppError {
  return new AppError({
    code: "offering.not_found",
    title: "Offering not found",
    status: 404,
    detail: "The requested offering does not exist.",
  });
}
