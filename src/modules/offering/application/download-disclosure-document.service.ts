import { AppError } from "../../../shared/errors/app-error.js";
import type { DisclosureDocumentRepository } from "../repository/disclosure-document.repository.js";
import type {
  DisclosureDocumentStore,
  StoredDisclosureDocument,
} from "./disclosure-document-store.js";

export interface DisclosureDocumentDownload extends StoredDisclosureDocument {
  fileName: string;
}

export class DownloadDisclosureDocumentService {
  public constructor(
    private readonly repository: DisclosureDocumentRepository,
    private readonly store: DisclosureDocumentStore,
  ) {}

  public async execute(input: {
    accountId: string;
    offeringId: string;
    documentId: string;
  }): Promise<DisclosureDocumentDownload> {
    const document = await this.repository.getAccessibleDocument(input);
    if (document === null) {
      throw new AppError({
        code: "offering.document_not_found",
        title: "Disclosure document not found",
        status: 404,
        detail: "The requested disclosure document is unavailable.",
      });
    }

    const stored = await this.store.get(document.documentReference);
    if (stored === null) {
      throw new AppError({
        code: "offering.document_storage_inconsistent",
        title: "Disclosure document unavailable",
        status: 503,
        detail: "The disclosure document is temporarily unavailable.",
      });
    }

    return {
      ...stored,
      fileName:
        stored.fileName ??
        `${toSafeFileName(document.documentType)}-v${document.disclosurePackVersion}`,
    };
  }
}

function toSafeFileName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return normalized || "disclosure-document";
}
