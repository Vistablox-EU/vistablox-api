import { Readable } from "node:stream";

import {
  GetObjectCommand,
  NoSuchKey,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

import type {
  DisclosureDocumentStore,
  StoredDisclosureDocument,
} from "../../modules/offering/application/disclosure-document-store.js";
import { AppError } from "../../shared/errors/app-error.js";

export class MinioDisclosureDocumentStore implements DisclosureDocumentStore {
  private readonly client: S3Client;

  public constructor(
    private readonly options: {
      endPoint: string;
      port: number;
      useSSL: boolean;
      accessKey: string;
      secretKey: string;
      bucket: string;
    },
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: `${options.useSSL ? "https" : "http"}://${options.endPoint}:${options.port}`,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: options.accessKey,
          secretAccessKey: options.secretKey,
        },
      });
  }

  public async get(documentReference: string): Promise<StoredDisclosureDocument | null> {
    const objectName = toObjectName(documentReference);
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: objectName,
        }),
      );
      if (!(object.Body instanceof Readable) || object.ContentLength === undefined) {
        object.Body?.transformToWebStream().cancel().catch(() => {});
        throw invalidStorageResponseError();
      }
      return {
        body: object.Body,
        contentType: object.ContentType ?? "application/octet-stream",
        contentLength: object.ContentLength,
        fileName: object.Metadata?.["original-filename"] ?? null,
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      if (error instanceof AppError) throw error;
      throw storageUnavailableError(error);
    }
  }
}

export class UnavailableDisclosureDocumentStore implements DisclosureDocumentStore {
  public async get(): Promise<never> {
    throw new AppError({
      code: "infrastructure.document_storage_unavailable",
      title: "Document storage unavailable",
      status: 503,
      detail: "The document storage dependency is not configured.",
    });
  }
}

function toObjectName(documentReference: string): string {
  const normalized = documentReference.replace(/^\/+/, "");
  if (
    normalized.length === 0 ||
    normalized.length > 1_024 ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new AppError({
      code: "offering.document_reference_invalid",
      title: "Disclosure document unavailable",
      status: 503,
      detail: "The stored disclosure document reference is invalid.",
    });
  }
  return normalized;
}

function isMissingObject(error: unknown): boolean {
  return (
    error instanceof NoSuchKey ||
    (error instanceof S3ServiceException &&
      (error.$metadata.httpStatusCode === 404 || error.name === "NotFound"))
  );
}

function invalidStorageResponseError(): AppError {
  return new AppError({
    code: "infrastructure.document_storage_invalid_response",
    title: "Document storage unavailable",
    status: 503,
    detail: "The document storage dependency returned an invalid response.",
  });
}

function storageUnavailableError(cause: unknown): AppError {
  return new AppError({
    code: "infrastructure.document_storage_unavailable",
    title: "Document storage unavailable",
    status: 503,
    detail: "The document storage dependency is temporarily unavailable.",
    cause,
  });
}
