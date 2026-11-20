import { Readable } from "node:stream";

import { DeleteObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { Jimp } from "jimp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UploadCaseDocumentService } from "../src/modules/intake/application/upload-case-document.service.js";
import { OBJECT_DELETE_FAILED } from "../src/shared/logging/object-delete-failure.js";
import { createMemoryLogger } from "./support/memory-logger.js";

vi.mock("../src/modules/intake/repository/intake-case-event.repository.js", () => ({
  appendIntakeCaseEvent: vi.fn().mockResolvedValue("event_1"),
}));

// The object-store deletes in UploadCaseDocumentService run after the database
// has already marked the rows deleted (or, on a failed upload, after nothing
// was recorded), so a failed delete cannot change the answer. It used to
// vanish without a trace; it is now a warn line, and these tests pin that
// for every call site: deletePhoto, deleteRoom and the upload rollback.

const BUCKET = "vistablox-private";
const WARN = 40;
const caseId = "case_01HXCASE";
const roomId = "room_1";
const photoKey = `intake/${caseId}/revisions/1/doc_photo`;
const thumbnailKey = `intake/${caseId}/revisions/1/doc_photo-thumbnail`;

/** What an unreachable MinIO throws: the endpoint URL is in the message. */
function storageError(key: string): Error {
  return Object.assign(new Error(`connect ECONNREFUSED http://minio.internal:9000/${BUCKET}/${key}`), { name: "TimeoutError" });
}

function makeStorage(failingKeys: ReadonlySet<string> | "all" = new Set()) {
  const deleteAttempts: string[] = [];
  const puts: string[] = [];
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key!;
      deleteAttempts.push(key);
      if (failingKeys === "all" || failingKeys.has(key)) throw storageError(key);
    }
    if (command instanceof PutObjectCommand) puts.push(command.input.Key!);
    return {};
  });
  return { storage: { send } as unknown as S3Client, deleteAttempts, puts };
}

function makeService(failingKeys: ReadonlySet<string> | "all", database: unknown) {
  const { storage, deleteAttempts, puts } = makeStorage(failingKeys);
  const { logger, lines } = createMemoryLogger();
  const service = new UploadCaseDocumentService(database as never, storage, BUCKET, { scan: vi.fn().mockResolvedValue("clean") }, logger);
  return { service, deleteAttempts, puts, lines };
}

function transactional(tx: unknown) {
  return { $transaction: async (callback: (transaction: unknown) => unknown) => callback(tx) };
}

describe("UploadCaseDocumentService.deletePhoto", () => {
  function photoDatabase() {
    const tx = {
      storedDocument: {
        findFirst: vi.fn().mockResolvedValue({ id: "doc_photo", objectKey: photoKey, variants: [{ objectKey: thumbnailKey }] }),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      propertyRoom: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    return { tx, database: transactional(tx) };
  }
  const input = { caseId, roomId, documentId: "doc_photo", actorAccountId: "account_staff", traceId: "req_01" };

  it("logs one warning per object that could not be deleted and still completes the removal", async () => {
    const { tx, database } = photoDatabase();
    const { service, deleteAttempts, lines } = makeService(new Set([photoKey, thumbnailKey]), database);

    await expect(service.deletePhoto(input)).resolves.toBeUndefined();

    // The rows were marked deleted before the object deletes, and a failed
    // first delete does not stop the second.
    expect(tx.storedDocument.updateMany).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(deleteAttempts).toEqual([photoKey, thumbnailKey]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: WARN,
      event: OBJECT_DELETE_FAILED,
      operation: "intake.room_photo_delete",
      bucket: BUCKET,
      object_key: photoKey,
      document_id: "doc_photo",
      trace_id: "req_01",
      err: { message: expect.stringContaining("ECONNREFUSED") },
    });
    expect(lines[1]).toMatchObject({ level: WARN, event: OBJECT_DELETE_FAILED, operation: "intake.room_photo_delete", bucket: BUCKET, object_key: thumbnailKey, trace_id: "req_01" });
    // The storage endpoint is not repeated in the line.
    expect(JSON.stringify(lines)).not.toContain("minio.internal");
  });

  it("logs exactly once when only one of the objects cannot be deleted", async () => {
    const { database } = photoDatabase();
    const { service, deleteAttempts, lines } = makeService(new Set([thumbnailKey]), database);

    await expect(service.deletePhoto(input)).resolves.toBeUndefined();

    expect(deleteAttempts).toEqual([photoKey, thumbnailKey]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ object_key: thumbnailKey });
  });

  it("logs nothing when the deletes succeed", async () => {
    const { database } = photoDatabase();
    const { service, deleteAttempts, lines } = makeService(new Set(), database);

    await expect(service.deletePhoto(input)).resolves.toBeUndefined();

    expect(deleteAttempts).toEqual([photoKey, thumbnailKey]);
    expect(lines).toEqual([]);
  });

  it("touches neither storage nor the log when there is no such photo", async () => {
    const { tx, database } = photoDatabase();
    tx.storedDocument.findFirst.mockResolvedValue(null);
    const { service, deleteAttempts, lines } = makeService(new Set([photoKey]), database);

    await expect(service.deletePhoto(input)).resolves.toBeUndefined();

    expect(deleteAttempts).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("UploadCaseDocumentService.deleteRoom", () => {
  const liveKey = `intake/${caseId}/revisions/1/doc_live`;
  const liveThumbnailKey = `${liveKey}-thumbnail`;
  const goneKey = `intake/${caseId}/revisions/1/doc_gone`;
  const goneThumbnailKey = `${goneKey}-thumbnail`;
  const earlier = new Date("2026-11-01T00:00:00.000Z");

  function roomDatabase() {
    const tx = {
      propertyRoom: {
        findFirst: vi.fn().mockResolvedValue({ id: roomId, roomType: "bedroom", sizeSqM: { toString: () => "12.5" } }),
        delete: vi.fn().mockResolvedValue({}),
      },
      storedDocument: {
        findMany: vi.fn().mockResolvedValue([
          { id: "doc_live", objectKey: liveKey, deletedAt: null, variants: [{ id: "doc_live_thumbnail", objectKey: liveThumbnailKey, deletedAt: null }] },
          // Deleted by an earlier deletePhoto: its objects are already gone and are not touched again.
          { id: "doc_gone", objectKey: goneKey, deletedAt: earlier, variants: [{ id: "doc_gone_thumbnail", objectKey: goneThumbnailKey, deletedAt: earlier }] },
        ]),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    return { tx, database: transactional(tx) };
  }
  const input = { caseId, roomId, actorAccountId: "account_staff", traceId: "req_02" };

  it("logs one warning per live object that could not be deleted and still removes the room", async () => {
    const { tx, database } = roomDatabase();
    const { service, deleteAttempts, lines } = makeService(new Set([liveKey, liveThumbnailKey]), database);

    await expect(service.deleteRoom(input)).resolves.toBeUndefined();

    expect(tx.propertyRoom.delete).toHaveBeenCalledOnce();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(deleteAttempts).toEqual([liveKey, liveThumbnailKey]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: WARN,
      event: OBJECT_DELETE_FAILED,
      operation: "intake.room_delete",
      bucket: BUCKET,
      object_key: liveKey,
      document_id: "doc_live",
      trace_id: "req_02",
      err: { message: expect.stringContaining("ECONNREFUSED") },
    });
    expect(lines[1]).toMatchObject({ level: WARN, operation: "intake.room_delete", object_key: liveThumbnailKey, document_id: "doc_live_thumbnail" });
  });

  it("logs exactly once when the variant is the only delete that fails", async () => {
    const { database } = roomDatabase();
    const { service, lines } = makeService(new Set([liveThumbnailKey]), database);

    await expect(service.deleteRoom(input)).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ object_key: liveThumbnailKey });
  });

  it("logs nothing when the deletes succeed", async () => {
    const { database } = roomDatabase();
    const { service, deleteAttempts, lines } = makeService(new Set(), database);

    await expect(service.deleteRoom(input)).resolves.toBeUndefined();

    expect(deleteAttempts).toEqual([liveKey, liveThumbnailKey]);
    expect(lines).toEqual([]);
  });
});

describe("UploadCaseDocumentService.execute rollback", () => {
  const BODY_TEXT = "private-file-content-0123456789";
  const ORIGINAL_FILENAME = "Marija Horvat passport scan.pdf";
  let png: Buffer;

  beforeEach(async () => {
    const image = new Jimp({ width: 8, height: 8, color: 0x336699ff });
    png = await image.getBuffer("image/png");
  });

  function uploadDatabase(transaction: () => Promise<unknown>) {
    return {
      intakeCase: { findUnique: vi.fn().mockResolvedValue({ id: caseId, currentSubmissionRevisionId: "rev_1" }) },
      submissionRevision: { findFirst: vi.fn().mockResolvedValue({ id: "rev_1" }) },
      propertyRoom: { findFirst: vi.fn().mockResolvedValue({ id: roomId }) },
      storedDocument: { count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn(transaction),
    };
  }

  function upload(service: UploadCaseDocumentService, overrides: Partial<Parameters<UploadCaseDocumentService["execute"]>[0]> = {}) {
    return service.execute({
      caseId,
      documentType: "registry_extract",
      revisionNumber: 1,
      body: Readable.from([Buffer.from(`%PDF-1.4 ${BODY_TEXT}`)]),
      contentType: "application/pdf",
      originalFilename: ORIGINAL_FILENAME,
      actorAccountId: "account_staff",
      traceId: "req_03",
      ...overrides,
    });
  }

  it("logs the failed deletes of the photo and its thumbnail and still throws the original error", async () => {
    const failure = new Error("database down");
    const database = uploadDatabase(async () => { throw failure; });
    // The keys are generated per upload, so the storage fails every delete.
    const { service, deleteAttempts, puts, lines } = makeService("all", database);

    await expect(upload(service, { documentType: "room_photo", roomId, body: Readable.from([png]), contentType: "image/png" })).rejects.toBe(failure);

    // Put order is the object, then its thumbnail; the rollback removes the thumbnail first.
    const [mainKey, thumbnail] = puts as [string, string];
    expect(thumbnail).toBe(`${mainKey}-thumbnail`);
    expect(deleteAttempts).toEqual([thumbnail, mainKey]);

    const documentId = mainKey.split("/").at(-1)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      level: WARN,
      event: OBJECT_DELETE_FAILED,
      operation: "intake.document_upload_rollback",
      bucket: BUCKET,
      object_key: thumbnail,
      document_id: `${documentId}_thumbnail`,
      trace_id: "req_03",
      err: { message: expect.stringContaining("ECONNREFUSED") },
    });
    expect(lines[1]).toMatchObject({ level: WARN, operation: "intake.document_upload_rollback", bucket: BUCKET, object_key: mainKey, document_id: documentId });
  });

  it("logs exactly once for a document that has no thumbnail", async () => {
    const failure = new Error("database down");
    const database = uploadDatabase(async () => { throw failure; });
    const { service, deleteAttempts, puts, lines } = makeService("all", database);

    await expect(upload(service)).rejects.toBe(failure);

    expect(puts).toHaveLength(1);
    expect(deleteAttempts).toEqual(puts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ operation: "intake.document_upload_rollback", object_key: puts[0] });
  });

  it("puts no file content, file name or other personal data in the line", async () => {
    const database = uploadDatabase(async () => { throw new Error("database down"); });
    const { service, lines } = makeService("all", database);

    await expect(upload(service)).rejects.toThrow("database down");

    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain(BODY_TEXT);
    expect(text).not.toContain("Marija");
    expect(text).not.toContain(".pdf");
    expect(text).not.toContain("application/pdf");
    expect(Object.keys(lines[0]!).sort()).toEqual(["bucket", "document_id", "err", "event", "level", "msg", "object_key", "operation", "time", "trace_id"]);
  });

  it("logs nothing when the rollback deletes succeed, and the original error is still thrown", async () => {
    const failure = new Error("database down");
    const database = uploadDatabase(async () => { throw failure; });
    const { service, deleteAttempts, puts, lines } = makeService(new Set(), database);

    await expect(upload(service)).rejects.toBe(failure);

    expect(deleteAttempts).toEqual(puts);
    expect(lines).toEqual([]);
  });

  it("deletes nothing and logs nothing when the upload is accepted", async () => {
    const database = uploadDatabase(async () => undefined);
    const { service, deleteAttempts, lines } = makeService("all", database);

    const result = await upload(service);

    expect(result).toMatchObject({ upload_status: "accepted", document_type: "registry_extract" });
    expect(deleteAttempts).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("UploadCaseDocumentService without a logger", () => {
  it("still completes when a delete fails", async () => {
    const tx = {
      storedDocument: {
        findFirst: vi.fn().mockResolvedValue({ id: "doc_photo", objectKey: photoKey, variants: [] }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      propertyRoom: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const { storage, deleteAttempts } = makeStorage(new Set([photoKey]));
    const service = new UploadCaseDocumentService(transactional(tx) as never, storage, BUCKET, { scan: vi.fn() });

    await expect(service.deletePhoto({ caseId, roomId, documentId: "doc_photo", actorAccountId: "account_staff" })).resolves.toBeUndefined();
    expect(deleteAttempts).toEqual([photoKey]);
  });
});
