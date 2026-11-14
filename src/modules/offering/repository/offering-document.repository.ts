/**
 * Staff-uploaded disclosure documents: the `platform.stored_documents` rows
 * with an `offering_id`, living in the disclosures bucket. A row here is what
 * a disclosure pack's `document_ref` must point at (publishDisclosurePack
 * refuses any other reference), and what the existing investor download
 * (`MinioDisclosureDocumentStore.get`) later streams by that same key.
 */
export interface OfferingDocumentRecord {
  documentId: string;
  offeringId: string;
  documentType: string;
  /** The object key in the disclosures bucket — the value a pack's `document_ref` carries. */
  documentRef: string;
  contentType: string;
  sizeBytes: number;
  sha256Checksum: string;
  originalFilename: string | null;
  uploadedAt: Date;
}

export interface OfferingDocumentListItem extends OfferingDocumentRecord {
  /** The most recently published pack whose documents reference this upload, if any. */
  publishedInPackId: string | null;
}

export interface CreateOfferingDocumentInput {
  documentId: string;
  offeringId: string;
  documentType: string;
  documentRef: string;
  contentType: string;
  sizeBytes: number;
  sha256Checksum: string;
  originalFilename: string;
  actorAccountId: string;
  traceId: string;
  uploadedAt: Date;
}

export interface OfferingDocumentRepository {
  offeringExists(offeringId: string): Promise<boolean>;
  /** Writes the accepted metadata row and its audit entry in one transaction. */
  createOfferingDocument(input: CreateOfferingDocumentInput): Promise<void>;
  /** Accepted, non-deleted uploads of the offering, newest first. */
  listOfferingDocuments(input: { offeringId: string; documentType?: string }): Promise<OfferingDocumentListItem[]>;
  findOfferingDocumentByRef(input: { offeringId: string; documentRef: string }): Promise<OfferingDocumentRecord | null>;
}
