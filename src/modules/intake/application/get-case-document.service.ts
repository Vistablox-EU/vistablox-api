import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { AppError } from "../../../shared/errors/app-error.js";

export class GetCaseDocumentService {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly storage: S3Client,
    private readonly bucket: string,
  ) {}

  public async execute(input: { caseId: string; documentRef: string }) {
    const document = await this.database.storedDocument.findFirst({
      where: { caseId: input.caseId, bucket: this.bucket, objectKey: input.documentRef, uploadStatus: "accepted", deletedAt: null },
      select: { objectKey: true, contentType: true, sizeBytes: true },
    });
    if (document === null) {
      throw new AppError({ code: "intake.document_not_found", title: "Document not found", status: 404, detail: "The requested case document does not exist." });
    }
    const object = await this.storage.send(new GetObjectCommand({ Bucket: this.bucket, Key: document.objectKey }));
    if (object.Body === undefined) throw new AppError({ code: "intake.document_unavailable", title: "Document unavailable", status: 503, detail: "The requested case document is temporarily unavailable." });
    return { body: object.Body, contentType: document.contentType, sizeBytes: Number(document.sizeBytes) };
  }

  public async list(input: { caseId: string; documentType?: string; roomId?: string }) {
    return this.database.storedDocument.findMany({
      where: { caseId: input.caseId, bucket: this.bucket, uploadStatus: "accepted", deletedAt: null, variantType: null, ...(input.documentType === undefined ? {} : { documentType: input.documentType }), ...(input.roomId === undefined ? {} : { roomId: input.roomId }) },
      select: { id: true, objectKey: true, documentType: true, contentType: true },
      orderBy: { createdAt: "asc" },
    });
  }
}
