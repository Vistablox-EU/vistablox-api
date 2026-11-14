import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  CreateOfferingDocumentInput,
  OfferingDocumentListItem,
  OfferingDocumentRecord,
  OfferingDocumentRepository,
} from "./offering-document.repository.js";

/**
 * `classification` vocabulary on stored_documents is free text with a
 * `private` default (intake's case evidence). Disclosure documents are not
 * private to one account — every authenticated investor may read the current
 * pack — so they get their own value rather than inheriting intake's.
 */
export const DISCLOSURE_DOCUMENT_CLASSIFICATION = "disclosure";

export class PrismaOfferingDocumentRepository implements OfferingDocumentRepository {
  public constructor(
    private readonly database: DatabaseClient,
    /** The disclosures bucket every row this repository reads or writes lives in. */
    private readonly bucket: string,
  ) {}

  public async offeringExists(offeringId: string): Promise<boolean> {
    const offering = await this.database.offering.findUnique({ where: { id: offeringId }, select: { id: true } });
    return offering !== null;
  }

  public async createOfferingDocument(input: CreateOfferingDocumentInput): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      await transaction.storedDocument.create({
        data: {
          id: input.documentId,
          bucket: this.bucket,
          objectKey: input.documentRef,
          documentType: input.documentType,
          offeringId: input.offeringId,
          contentType: input.contentType,
          sizeBytes: BigInt(input.sizeBytes),
          sha256Checksum: input.sha256Checksum,
          uploadStatus: "accepted",
          classification: DISCLOSURE_DOCUMENT_CLASSIFICATION,
          originalFilename: input.originalFilename,
          createdAt: input.uploadedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "offering.disclosure_document_uploaded",
          resourceType: "offering",
          resourceId: input.offeringId,
          changes: {
            trace_id: input.traceId,
            document_id: input.documentId,
            document_type: input.documentType,
            document_ref: input.documentRef,
            content_type: input.contentType,
            size_bytes: input.sizeBytes,
            sha256_checksum: input.sha256Checksum,
          },
          createdAt: input.uploadedAt,
        },
      });
    });
  }

  public async listOfferingDocuments(input: { offeringId: string; documentType?: string }): Promise<OfferingDocumentListItem[]> {
    const rows = await this.database.storedDocument.findMany({
      where: {
        offeringId: input.offeringId,
        bucket: this.bucket,
        uploadStatus: "accepted",
        deletedAt: null,
        ...(input.documentType === undefined ? {} : { documentType: input.documentType }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (rows.length === 0) return [];

    // Newest pack first, so the first row seen per document_ref is the most
    // recent pack that references it — whether or not that pack is still
    // current.
    const references = await this.database.disclosureDocument.findMany({
      where: {
        documentRef: { in: rows.map((row) => row.objectKey) },
        disclosurePack: { offeringId: input.offeringId },
      },
      select: { documentRef: true, disclosurePackId: true },
      orderBy: [{ disclosurePack: { version: "desc" } }],
    });
    const latestPackByRef = new Map<string, string>();
    for (const reference of references) {
      if (!latestPackByRef.has(reference.documentRef)) latestPackByRef.set(reference.documentRef, reference.disclosurePackId);
    }

    return rows.map((row) => ({ ...toRecord(row), publishedInPackId: latestPackByRef.get(row.objectKey) ?? null }));
  }

  public async findOfferingDocumentByRef(input: { offeringId: string; documentRef: string }): Promise<OfferingDocumentRecord | null> {
    const row = await this.database.storedDocument.findFirst({
      where: { offeringId: input.offeringId, bucket: this.bucket, objectKey: input.documentRef, uploadStatus: "accepted", deletedAt: null },
    });
    return row === null ? null : toRecord(row);
  }
}

function toRecord(row: {
  id: string;
  offeringId: string | null;
  documentType: string;
  objectKey: string;
  contentType: string;
  sizeBytes: bigint;
  sha256Checksum: string;
  originalFilename: string | null;
  createdAt: Date;
}): OfferingDocumentRecord {
  return {
    documentId: row.id,
    offeringId: row.offeringId ?? "",
    documentType: row.documentType,
    documentRef: row.objectKey,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    sha256Checksum: row.sha256Checksum,
    originalFilename: row.originalFilename,
    uploadedAt: row.createdAt,
  };
}
