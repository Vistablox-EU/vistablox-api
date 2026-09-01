import { Readable } from "node:stream";

import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { MinioDisclosureDocumentStore } from "../src/infrastructure/storage/minio-disclosure-document.store.js";

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
});
