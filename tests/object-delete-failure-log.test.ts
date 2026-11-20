import { describe, expect, it, vi } from "vitest";

import { OBJECT_DELETE_FAILED, logObjectDeleteFailure } from "../src/shared/logging/object-delete-failure.js";
import { createMemoryLogger } from "./support/memory-logger.js";

describe("logObjectDeleteFailure", () => {
  it("writes one warn line with the identifiers it was given", () => {
    const { logger, lines } = createMemoryLogger();

    logObjectDeleteFailure(logger, {
      operation: "intake.room_photo_delete",
      bucket: "vistablox-private",
      objectKey: "intake/case_1/revisions/1/doc_a",
      documentId: "doc_a",
      traceId: "req_9",
      error: new Error("minio down"),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 40,
      event: OBJECT_DELETE_FAILED,
      operation: "intake.room_photo_delete",
      bucket: "vistablox-private",
      object_key: "intake/case_1/revisions/1/doc_a",
      document_id: "doc_a",
      trace_id: "req_9",
      err: { message: "minio down" },
    });
  });

  it("leaves out what the caller does not know instead of logging null or undefined", () => {
    const { logger, lines } = createMemoryLogger();

    logObjectDeleteFailure(logger, { operation: "offering.document_upload_rollback", objectKey: "offerings/o_1/doc_b", error: new Error("x") });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty("bucket");
    expect(lines[0]).not.toHaveProperty("document_id");
    expect(lines[0]).not.toHaveProperty("trace_id");
  });

  it("strips URLs from the error, which a storage client puts there with the endpoint", () => {
    const { logger, lines } = createMemoryLogger();
    const error = new Error("getaddrinfo ENOTFOUND http://minio-key:minio-secret@minio.internal:9000/bucket");
    error.stack = `Error: ${error.message}\n    at send (file:///app/dist/server.js:1:1)`;

    logObjectDeleteFailure(logger, { operation: "op", objectKey: "k", error });

    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain("minio-secret");
    expect(text).not.toContain("minio.internal");
    expect(text).toContain("[url]");
  });

  it("copes with a thrown value that is not an Error", () => {
    const { logger, lines } = createMemoryLogger();

    logObjectDeleteFailure(logger, { operation: "op", objectKey: "k", error: "plain string" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ err: { message: "plain string" } });
  });

  it("writes nothing and does not throw without a logger", () => {
    expect(() => logObjectDeleteFailure(undefined, { operation: "op", objectKey: "k", error: new Error("x") })).not.toThrow();
  });

  it("calls warn exactly once per failure", () => {
    const warn = vi.fn();
    logObjectDeleteFailure({ warn } as never, { operation: "op", objectKey: "k", error: new Error("x") });
    expect(warn).toHaveBeenCalledOnce();
  });
});
