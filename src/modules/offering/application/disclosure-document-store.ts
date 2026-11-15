import type { Readable } from "node:stream";

export interface StoredDisclosureDocument {
  body: Readable;
  contentType: string;
  contentLength: number;
  fileName: string | null;
}

export interface DisclosureDocumentStore {
  get(documentReference: string): Promise<StoredDisclosureDocument | null>;
}

export interface DisclosureDocumentUpload {
  /** Object key inside the disclosures bucket; server-generated, never a client value. */
  documentReference: string;
  body: Buffer;
  contentType: string;
  /** Printable-ASCII values only: S3 user metadata travels as HTTP headers. */
  metadata: Record<string, string>;
}

/**
 * The write side of the disclosures bucket, used by staff uploads
 * (UploadOfferingDocumentService). Kept separate from DisclosureDocumentStore
 * so the investor download path and its test doubles stay read-only.
 */
export interface WritableDisclosureDocumentStore extends DisclosureDocumentStore {
  put(input: DisclosureDocumentUpload): Promise<void>;
  /** Removes an object; used to undo an upload whose metadata row failed. */
  delete(documentReference: string): Promise<void>;
}
