import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { objectKey } from "../../../infrastructure/storage/storage-buckets.js";
import type { MalwareScanner } from "../../../infrastructure/antivirus/clamav-scanner.js";
import { submissionEvidenceTypes } from "../domain/case-submission.policy.js";
import { appendIntakeCaseEvent } from "../repository/intake-case-event.repository.js";
import { Jimp } from "jimp";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const DELETED_DOCUMENT_RETENTION_DAYS = 30;
const ALLOWED = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
const ALLOWED_DOCUMENT_TYPES = new Set<string>(submissionEvidenceTypes);
ALLOWED_DOCUMENT_TYPES.add("room_photo");

export class UploadCaseDocumentService {
  public constructor(private readonly database: DatabaseClient, private readonly storage: S3Client, private readonly bucket: string, private readonly scanner: MalwareScanner) {}

  public async setRepresentative(input: { caseId: string; roomId: string; documentId: string; actorAccountId: string; traceId?: string }): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const photo = await transaction.storedDocument.findFirst({ where: { id: input.documentId, caseId: input.caseId, roomId: input.roomId, documentType: "room_photo", uploadStatus: "accepted", deletedAt: null }, select: { id: true } });
      if (photo === null) throw new AppError({ code: "intake.room_photo_not_found", title: "Room photo not found", status: 404, detail: "The selected room photo does not exist." });
      const room = await transaction.propertyRoom.findFirst({ where: { id: input.roomId, property: { cases: { some: { id: input.caseId } } } }, select: { id: true } });
      if (room === null) throw new AppError({ code: "intake.room_not_found", title: "Room not found", status: 404, detail: "The selected room does not belong to this intake case." });
      await transaction.propertyRoom.update({ where: { id: input.roomId }, data: { preferredPhotoId: input.documentId } });
      await transaction.auditLog.create({ data: { id: `audit_${randomUUID()}`, actorAccountId: input.actorAccountId, action: "intake.room_photo_representative_selected", resourceType: "intake_case", resourceId: input.caseId, changes: { room_id: input.roomId, document_id: input.documentId } } });
      await appendIntakeCaseEvent(transaction, { caseId: input.caseId, eventKey: `case:${input.caseId}:room-photo-representative:${input.documentId}:${input.traceId ?? "unknown"}`, eventType: "room_photo_representative_selected", actorType: "staff", actorAccountId: input.actorAccountId, traceId: input.traceId ?? null, relatedResourceType: "stored_document", relatedResourceId: input.documentId, metadata: { room_id: input.roomId }, occurredAt: new Date() });
    });
  }

  public async deletePhoto(input: { caseId: string; roomId: string; documentId: string; actorAccountId: string; traceId?: string; reason?: string }): Promise<void> {
    const documents = await this.database.$transaction(async (transaction) => {
      const photo = await transaction.storedDocument.findFirst({ where: { id: input.documentId, caseId: input.caseId, roomId: input.roomId, documentType: "room_photo", uploadStatus: "accepted", deletedAt: null }, select: { id: true, objectKey: true, variants: { select: { objectKey: true } } } });
      if (photo === null) return null;
      const now = new Date();
      const retentionUntil = new Date(now.getTime() + DELETED_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await transaction.storedDocument.updateMany({ where: { OR: [{ id: input.documentId }, { sourceDocumentId: input.documentId }], deletedAt: null }, data: { deletedAt: now, deletedByAccountId: input.actorAccountId, deletionReason: input.reason ?? "staff_deleted", retentionUntil } });
      await transaction.propertyRoom.updateMany({ where: { id: input.roomId, preferredPhotoId: input.documentId }, data: { preferredPhotoId: null } });
      await transaction.auditLog.create({ data: { id: `audit_${randomUUID()}`, actorAccountId: input.actorAccountId, action: "intake.room_photo_deleted", resourceType: "intake_case", resourceId: input.caseId, changes: { room_id: input.roomId, document_id: input.documentId, reason: input.reason ?? "staff_deleted" } } });
      await appendIntakeCaseEvent(transaction, { caseId: input.caseId, eventKey: `case:${input.caseId}:room-photo-deleted:${input.documentId}:${input.traceId ?? "unknown"}`, eventType: "room_photo_deleted", actorType: "staff", actorAccountId: input.actorAccountId, traceId: input.traceId ?? null, relatedResourceType: "stored_document", relatedResourceId: input.documentId, metadata: { room_id: input.roomId }, occurredAt: now });
      return photo;
    });
    if (documents !== null) {
      // Metadata is retained for audit; object deletion is best-effort and can be retried by the purge job.
      await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: documents.objectKey })).catch(() => undefined);
      for (const variant of documents.variants) await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: variant.objectKey })).catch(() => undefined);
    }
  }

  public async deleteRoom(input: { caseId: string; roomId: string; actorAccountId: string; traceId?: string; reason?: string }): Promise<void> {
    const documents = await this.database.$transaction(async (transaction) => {
      const room = await transaction.propertyRoom.findFirst({
        where: { id: input.roomId, property: { cases: { some: { id: input.caseId } } } },
        select: { id: true, roomType: true, sizeSqM: true },
      });
      if (room === null) throw new AppError({ code: "intake.room_not_found", title: "Room not found", status: 404, detail: "The selected room does not belong to this intake case." });

      const roomDocuments = await transaction.storedDocument.findMany({
        where: { roomId: input.roomId },
        select: { id: true, objectKey: true, deletedAt: true, variants: { select: { id: true, objectKey: true, deletedAt: true } } },
      });
      const now = new Date();
      const retentionUntil = new Date(now.getTime() + DELETED_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await transaction.storedDocument.updateMany({
        where: { roomId: input.roomId, deletedAt: null },
        data: { deletedAt: now, deletedByAccountId: input.actorAccountId, deletionReason: input.reason ?? "room_deleted", retentionUntil },
      });
      await transaction.storedDocument.updateMany({ where: { roomId: input.roomId }, data: { roomId: null } });
      await transaction.propertyRoom.delete({ where: { id: input.roomId } });
      await transaction.auditLog.create({ data: { id: `audit_${randomUUID()}`, actorAccountId: input.actorAccountId, action: "intake.room_deleted", resourceType: "intake_case", resourceId: input.caseId, changes: { room_id: input.roomId, room_type: room.roomType, size_sq_m: room.sizeSqM.toString(), photo_count: roomDocuments.filter((document) => document.deletedAt === null).length, reason: input.reason ?? "room_deleted" } } });
      await appendIntakeCaseEvent(transaction, { caseId: input.caseId, eventKey: `case:${input.caseId}:room-deleted:${input.roomId}:${input.traceId ?? "unknown"}`, eventType: "room_deleted", actorType: "staff", actorAccountId: input.actorAccountId, traceId: input.traceId ?? null, relatedResourceType: "property_room", relatedResourceId: input.roomId, metadata: { room_id: input.roomId, room_type: room.roomType, size_sq_m: room.sizeSqM.toString(), photo_count: roomDocuments.filter((document) => document.deletedAt === null).length }, occurredAt: now });
      return roomDocuments;
    });

    for (const document of documents) {
      if (document.deletedAt === null) await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: document.objectKey })).catch(() => undefined);
      for (const variant of document.variants) {
        if (variant.deletedAt === null) await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: variant.objectKey })).catch(() => undefined);
      }
    }
  }

  public async execute(input: { caseId: string; documentType: string; revisionNumber: number; roomId?: string; body: AsyncIterable<Buffer>; contentType: string; originalFilename: string; actorAccountId?: string; traceId?: string }): Promise<Record<string, unknown>> {
    if (!ALLOWED_DOCUMENT_TYPES.has(input.documentType)) throw new AppError({ code: "intake.document_type_unsupported", title: "Unsupported document", status: 422, detail: "This document type is not supported." });
    if (!ALLOWED.has(input.contentType)) throw new AppError({ code: "intake.document_mime_unsupported", title: "Unsupported document", status: 422, detail: "This file type is not supported." });
    if (input.documentType === "room_photo" && input.contentType !== "image/jpeg" && input.contentType !== "image/png" && input.contentType !== "image/webp") throw new AppError({ code: "intake.document_mime_unsupported", title: "Unsupported image", status: 422, detail: "Room photos must be JPEG, PNG, or WebP images." });
    if (input.documentType === "room_photo" && input.roomId === undefined) throw new AppError({ code: "intake.room_id_required", title: "Room required", status: 422, detail: "Room photos must identify a property room." });
    if (input.documentType !== "room_photo" && input.roomId !== undefined) throw new AppError({ code: "intake.room_id_unexpected", title: "Room not applicable", status: 422, detail: "Only room photos may be associated with a room." });
    const c = await this.database.intakeCase.findUnique({ where: { id: input.caseId }, select: { id: true, currentSubmissionRevisionId: true } });
    if (!c) throw new AppError({ code: "intake.case_not_found", title: "Case not found", status: 404, detail: "The intake case does not exist." });
    const revision = await this.database.submissionRevision.findFirst({ where: { caseId: input.caseId, revisionNumber: input.revisionNumber }, select: { id: true } });
    if (!revision || c.currentSubmissionRevisionId !== revision.id) throw new AppError({ code: "intake.revision_not_found", title: "Revision not found", status: 404, detail: "The requested submission revision does not exist." });
    if (input.roomId !== undefined) {
      const room = await this.database.propertyRoom.findFirst({ where: { id: input.roomId, property: { cases: { some: { id: input.caseId } } } }, select: { id: true } });
      if (room === null) throw new AppError({ code: "intake.room_not_found", title: "Room not found", status: 404, detail: "The selected room does not belong to this intake case." });
      const count = await this.database.storedDocument.count({ where: { caseId: input.caseId, roomId: input.roomId, documentType: "room_photo", uploadStatus: "accepted", deletedAt: null } });
      if (count >= 5) throw new AppError({ code: "intake.room_photo_limit_reached", title: "Room photo limit reached", status: 409, detail: "Each room may have at most five accepted photos." });
    }
    const chunks: Buffer[] = []; let size = 0; const hash = createHash("sha256");
    for await (const chunk of input.body) { const b = Buffer.from(chunk); size += b.length; if (size > MAX_BYTES) throw new AppError({ code: "intake.document_too_large", title: "Document too large", status: 413, detail: "Documents must be 100 MB or smaller." }); chunks.push(b); hash.update(b); }
    if (size === 0) throw new AppError({ code: "intake.document_empty", title: "Empty document", status: 422, detail: "The uploaded document is empty." });
    const bytes = Buffer.concat(chunks);
    if (input.documentType === "room_photo" && !hasSupportedImageSignature(bytes, input.contentType)) throw new AppError({ code: "intake.invalid_image", title: "Invalid image", status: 422, detail: "The uploaded file is not a valid supported image." });
    const documentId = `doc_${randomUUID().replaceAll("-", "")}`;
    const key = objectKey({ area: "intake", subjectId: input.caseId, revision: input.revisionNumber, documentId });
    const checksum = hash.digest("hex");
    let scan: "clean" | "infected";
    try { scan = await this.scanner.scan(bytes); }
    catch { throw new AppError({ code: "intake.document_scanner_unavailable", title: "Document scanner unavailable", status: 503, detail: "The document cannot be accepted while malware scanning is unavailable." }); }
    if (scan === "infected") throw new AppError({ code: "intake.document_malware_detected", title: "Document rejected", status: 422, detail: "The uploaded document was rejected by malware scanning." });
    await this.storage.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: input.contentType, Metadata: { "original-filename": input.originalFilename.slice(0, 255), "sha256": checksum } }));
    let thumbnailRef: string | null = null;
    try {
      const thumbnail = input.documentType === "room_photo" ? await createThumbnail(bytes) : null;
      if (thumbnail !== null) {
        thumbnailRef = objectKey({ area: "intake", subjectId: input.caseId, revision: input.revisionNumber, documentId: `${documentId}-thumbnail` });
        await this.storage.send(new PutObjectCommand({ Bucket: this.bucket, Key: thumbnailRef, Body: thumbnail, ContentType: "image/jpeg", Metadata: { "source-document-id": documentId, variant: "thumbnail" } }));
      }
      await this.database.$transaction(async (transaction) => {
        if (input.roomId !== undefined) {
          await transaction.$queryRaw`SELECT room_id FROM intake.property_rooms WHERE room_id = ${input.roomId} FOR UPDATE`;
          const count = await transaction.storedDocument.count({ where: { caseId: input.caseId, roomId: input.roomId, documentType: "room_photo", uploadStatus: "accepted", deletedAt: null } });
          if (count >= 5) throw new AppError({ code: "intake.room_photo_limit_reached", title: "Room photo limit reached", status: 409, detail: "Each room may have at most five active photos." });
        }
        await transaction.storedDocument.create({ data: { id: documentId, bucket: this.bucket, objectKey: key, documentType: input.documentType, caseId: input.caseId, roomId: input.roomId ?? null, contentType: input.contentType, sizeBytes: BigInt(size), sha256Checksum: checksum, uploadStatus: "accepted", classification: "private" } });
        if (input.actorAccountId !== undefined) {
          await appendIntakeCaseEvent(transaction, { caseId: input.caseId, eventKey: `case:${input.caseId}:document-uploaded:${documentId}`, eventType: input.documentType === "room_photo" ? "room_photo_uploaded" : "property_document_uploaded", actorType: "staff", actorAccountId: input.actorAccountId, traceId: input.traceId ?? null, relatedResourceType: "stored_document", relatedResourceId: documentId, metadata: { document_type: input.documentType, revision_number: input.revisionNumber, room_id: input.roomId ?? null }, occurredAt: new Date() });
        }
        if (thumbnailRef !== null && thumbnail !== null) {
          const thumbnailBytes = thumbnail;
          await transaction.storedDocument.create({ data: { id: `${documentId}_thumbnail`, bucket: this.bucket, objectKey: thumbnailRef, documentType: "room_photo_thumbnail", sourceDocumentId: documentId, variantType: "thumbnail", caseId: input.caseId, roomId: input.roomId ?? null, contentType: "image/jpeg", sizeBytes: BigInt(thumbnailBytes.length), sha256Checksum: createHash("sha256").update(thumbnailBytes).digest("hex"), uploadStatus: "accepted", classification: "private" } });
        }
      });
    } catch (error) {
      if (thumbnailRef !== null) await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: thumbnailRef })).catch(() => undefined);
      await this.storage.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => undefined);
      throw error;
    }
    return { document_id: documentId, document_type: input.documentType, document_ref: key, thumbnail_ref: thumbnailRef, upload_status: "accepted", content_type: input.contentType, size_bytes: size, sha256_checksum: checksum, original_filename: input.originalFilename.slice(0, 255) };
  }
}

function hasSupportedImageSignature(bytes: Buffer, contentType: string): boolean {
  if (contentType === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

async function createThumbnail(bytes: Buffer): Promise<Buffer> {
  try {
    const image = await Jimp.read(bytes);
    if (image.bitmap.width * image.bitmap.height > MAX_IMAGE_PIXELS) {
      throw new AppError({ code: "intake.image_dimensions_too_large", title: "Image dimensions too large", status: 422, detail: "The uploaded image has too many pixels." });
    }
    image.scaleToFit({ w: 640, h: 480 });
    return image.getBuffer("image/jpeg");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({ code: "intake.invalid_image", title: "Invalid image", status: 422, detail: "The uploaded file could not be decoded as an image." });
  }
}
