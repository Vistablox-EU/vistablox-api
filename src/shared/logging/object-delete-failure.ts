import type { Logger } from "pino";

import { toSanitizedError } from "./log-redaction.js";

/**
 * The `event` of the warn line written when an object-store delete fails and
 * the caller carries on regardless. A search or an alert keys on this value,
 * never on the message.
 */
export const OBJECT_DELETE_FAILED = "object_storage.delete_failed";

export interface ObjectDeleteFailure {
  /** The code path that tried the delete, e.g. "intake.room_photo_delete". */
  operation: string;
  /** Absent where the caller does not know it (the disclosures store owns its bucket). */
  bucket?: string | undefined;
  /** The key that is still in the bucket. It embeds the case or offering id. */
  objectKey: string;
  /** The stored_documents id, where the caller has it. */
  documentId?: string | undefined;
  traceId?: string | undefined;
  error: unknown;
}

/**
 * Records that an object could not be removed from storage. For the callers
 * that treat the delete as best effort: the request goes on as it did before,
 * but the object is still in the bucket and nothing retries the delete, so
 * this line is the only trace of it.
 *
 * Only identifiers go into the line: never the bytes, the file name or the
 * content type of the document. The error goes through toSanitizedError, so a
 * storage endpoint URL in its message or stack does not reach the log. A call
 * without a logger writes nothing.
 */
export function logObjectDeleteFailure(logger: Pick<Logger, "warn"> | undefined, failure: ObjectDeleteFailure): void {
  logger?.warn(
    {
      event: OBJECT_DELETE_FAILED,
      operation: failure.operation,
      ...(failure.bucket === undefined ? {} : { bucket: failure.bucket }),
      object_key: failure.objectKey,
      ...(failure.documentId === undefined ? {} : { document_id: failure.documentId }),
      ...(failure.traceId === undefined ? {} : { trace_id: failure.traceId }),
      err: toSanitizedError(failure.error),
    },
    "object delete failed; the object may still be in storage and nothing retries the delete",
  );
}
