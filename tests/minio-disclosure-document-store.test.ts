import { Readable } from "node:stream";

import { DeleteObjectCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  MinioDisclosureDocumentStore,
  UnavailableDisclosureDocumentStore,
} from "../src/infrastructure/storage/minio-disclosure-document.store.js";

function storeWith(client: Partial<S3Client>) {
  return new MinioDisclosureDocumentStore(
    {
      endPoint: "minio",
      port: 9000,
      useSSL: false,
      accessKey: "access-key",
      secretKey: "secret-key",
      bucket: "vistablox-documents",
    },
    client as S3Client,
  );
}

describe("MinIO disclosure document store", () => {
  it("returns object metadata and a readable body without creating a URL", async () => {
    const body = Readable.from(Buffer.from("document"));
    const client = {
      send: vi.fn().mockResolvedValue({
        Body: body,
        ContentLength: 8,
        ContentType: "application/pdf",
        Metadata: { "original-filename": "terms.pdf" },
      }),
    };

    await expect(storeWith(client).get("offering/terms.pdf")).resolves.toEqual({
      body,
      contentType: "application/pdf",
      contentLength: 8,
      fileName: "terms.pdf",
    });
    expect(client.send).toHaveBeenCalledOnce();
    const command = client.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: "vistablox-documents",
      Key: "offering/terms.pdf",
    });
  });

  it("rejects traversal-like stored references before calling storage", async () => {
    const client = { send: vi.fn() };

    await expect(storeWith(client).get("offering/../secret")).rejects.toMatchObject({
      code: "offering.document_reference_invalid",
      status: 503,
    });
    expect(client.send).not.toHaveBeenCalled();
  });

  it("maps storage failures to a provider-neutral service-unavailable error", async () => {
    const client = {
      send: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED minio")),
    };

    await expect(storeWith(client).get("offering/terms.pdf")).rejects.toMatchObject({
      code: "infrastructure.document_storage_unavailable",
      status: 503,
    });
  });

  it("writes an object with its content type and metadata into the configured bucket", async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    const body = Buffer.from("disclosure bytes");

    await storeWith(client).put({
      documentReference: "offerings/offering_01/doc_01",
      body,
      contentType: "application/pdf",
      metadata: { "original-filename": "terms.pdf", sha256: "abc" },
    });

    expect(client.send).toHaveBeenCalledOnce();
    const command = client.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: "vistablox-documents",
      Key: "offerings/offering_01/doc_01",
      Body: body,
      ContentLength: body.length,
      ContentType: "application/pdf",
      Metadata: { "original-filename": "terms.pdf", sha256: "abc" },
    });
  });

  it("refuses to write under a traversal-like key and maps write failures to 503", async () => {
    const refusing = { send: vi.fn() };
    await expect(
      storeWith(refusing).put({ documentReference: "offerings/../x", body: Buffer.from("x"), contentType: "application/pdf", metadata: {} }),
    ).rejects.toMatchObject({ code: "offering.document_reference_invalid", status: 503 });
    expect(refusing.send).not.toHaveBeenCalled();

    const failing = { send: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED minio")) };
    await expect(
      storeWith(failing).put({ documentReference: "offerings/offering_01/doc_01", body: Buffer.from("x"), contentType: "application/pdf", metadata: {} }),
    ).rejects.toMatchObject({ code: "infrastructure.document_storage_unavailable", status: 503 });
  });

  it("deletes an object, treating an already-missing one as done", async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    await storeWith(client).delete("offerings/offering_01/doc_01");
    const command = client.send.mock.calls[0]![0];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({ Bucket: "vistablox-documents", Key: "offerings/offering_01/doc_01" });

    const missing = {
      send: vi.fn().mockRejectedValue(new NoSuchKey({ message: "gone", $metadata: { httpStatusCode: 404 } })),
    };
    await expect(storeWith(missing).delete("offerings/offering_01/doc_01")).resolves.toBeUndefined();
  });

  it("fails closed on every operation when storage is not configured", async () => {
    const store = new UnavailableDisclosureDocumentStore();
    const unavailable = { code: "infrastructure.document_storage_unavailable", status: 503 };
    await expect(store.get()).rejects.toMatchObject(unavailable);
    await expect(store.put()).rejects.toMatchObject(unavailable);
    await expect(store.delete()).rejects.toMatchObject(unavailable);
  });
});
