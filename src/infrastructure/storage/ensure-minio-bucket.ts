import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { z } from "zod";

const input = z
  .object({
    MINIO_ENDPOINT: z.string().min(1),
    MINIO_PORT: z.coerce.number().int().min(1).max(65_535).default(9_000),
    MINIO_USE_SSL: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    MINIO_ACCESS_KEY: z.string().min(1),
    MINIO_SECRET_KEY: z.string().min(8),
    MINIO_DOCUMENT_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  })
  .parse(process.env);

const client = new S3Client({
  endpoint: `${input.MINIO_USE_SSL ? "https" : "http"}://${input.MINIO_ENDPOINT}:${input.MINIO_PORT}`,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: input.MINIO_ACCESS_KEY,
    secretAccessKey: input.MINIO_SECRET_KEY,
  },
});

try {
  await client.send(new HeadBucketCommand({ Bucket: input.MINIO_DOCUMENT_BUCKET }));
} catch (error) {
  if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404) {
    throw error;
  }
  await client.send(new CreateBucketCommand({ Bucket: input.MINIO_DOCUMENT_BUCKET }));
}
client.destroy();
