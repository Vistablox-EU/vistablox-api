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
