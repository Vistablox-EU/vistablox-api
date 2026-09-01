import { randomUUID } from "node:crypto";

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MinioDisclosureDocumentStore } from "../src/infrastructure/storage/minio-disclosure-document.store.js";

const endpoint = process.env.TEST_MINIO_ENDPOINT;
const accessKey = process.env.TEST_MINIO_ACCESS_KEY;
const secretKey = process.env.TEST_MINIO_SECRET_KEY;
const configured = endpoint !== undefined && accessKey !== undefined && secretKey !== undefined;
const port = Number(process.env.TEST_MINIO_PORT ?? "9000");

describe.skipIf(!configured)("MinIO disclosure document integration", () => {
  const bucket = `vistablox-test-${randomUUID()}`;
  const objectName = "offering_01/pack_2/kiis.pdf";
  const content = Buffer.from("integration disclosure document");
  const client = new S3Client({
    endpoint: `http://${endpoint ?? "127.0.0.1"}:${port}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: accessKey ?? "missing",
      secretAccessKey: secretKey ?? "missing-secret",
    },
  });
  const store = new MinioDisclosureDocumentStore(
    {
      endPoint: endpoint ?? "127.0.0.1",
      port,
      useSSL: false,
      accessKey: accessKey ?? "missing",
      secretKey: secretKey ?? "missing-secret",
      bucket,
    },
    client,
  );

  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectName,
        Body: content,
        ContentLength: content.length,
        ContentType: "application/pdf",
        Metadata: { "original-filename": "kiis-v2.pdf" },
      }),
    );
  });

  afterAll(async () => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectName }));
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  });

  it("streams a private MinIO object through the S3-compatible adapter", async () => {
    const result = await store.get(objectName);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      contentType: "application/pdf",
      contentLength: content.length,
      fileName: "kiis-v2.pdf",
    });

    const chunks: Buffer[] = [];
    for await (const chunk of result!.body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks)).toEqual(content);
  });

  it("returns null for an object that is not present", async () => {
    await expect(store.get("offering_01/missing.pdf")).resolves.toBeNull();
  });
});
