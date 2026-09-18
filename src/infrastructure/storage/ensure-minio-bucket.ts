import {
  CreateBucketCommand, HeadBucketCommand, PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand, PutObjectLockConfigurationCommand, S3Client, S3ServiceException,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { DEFAULT_STORAGE_BUCKETS } from "./storage-buckets.js";

const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const input = z.object({
  MINIO_ENDPOINT: z.string().min(1), MINIO_PORT: z.coerce.number().int().min(1).max(65_535).default(9_000),
  MINIO_USE_SSL: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  MINIO_ACCESS_KEY: z.string().min(1), MINIO_SECRET_KEY: z.string().min(8),
  MINIO_QUARANTINE_BUCKET: bucketName.default(DEFAULT_STORAGE_BUCKETS.quarantine),
  MINIO_PRIVATE_BUCKET: bucketName.default(DEFAULT_STORAGE_BUCKETS.private),
  MINIO_KYC_BUCKET: bucketName.default(DEFAULT_STORAGE_BUCKETS.kyc),
  MINIO_DISCLOSURES_BUCKET: bucketName.default(DEFAULT_STORAGE_BUCKETS.disclosures),
  MINIO_AUDIT_BUCKET: bucketName.default(DEFAULT_STORAGE_BUCKETS.audit),
}).parse(process.env);

const client = new S3Client({
  endpoint: `${input.MINIO_USE_SSL ? "https" : "http"}://${input.MINIO_ENDPOINT}:${input.MINIO_PORT}`,
  region: "us-east-1", forcePathStyle: true,
  credentials: { accessKeyId: input.MINIO_ACCESS_KEY, secretAccessKey: input.MINIO_SECRET_KEY },
});
const buckets = [
  { name: input.MINIO_QUARANTINE_BUCKET, versioned: false, locked: false, expireDays: 30 },
  { name: input.MINIO_PRIVATE_BUCKET, versioned: true, locked: false, expireDays: undefined },
  { name: input.MINIO_KYC_BUCKET, versioned: true, locked: false, expireDays: undefined },
  { name: input.MINIO_DISCLOSURES_BUCKET, versioned: true, locked: true, expireDays: undefined },
  { name: input.MINIO_AUDIT_BUCKET, versioned: true, locked: true, expireDays: undefined },
];
for (const bucket of buckets) {
  try { await client.send(new HeadBucketCommand({ Bucket: bucket.name })); }
  catch (error) {
    if (!(error instanceof S3ServiceException) || error.$metadata.httpStatusCode !== 404) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket.name, ObjectLockEnabledForBucket: bucket.locked }));
  }
  if (bucket.versioned) await client.send(new PutBucketVersioningCommand({ Bucket: bucket.name, VersioningConfiguration: { Status: "Enabled" } }));
  if (bucket.locked) {
    try { await client.send(new PutObjectLockConfigurationCommand({ Bucket: bucket.name, ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } })); }
    catch (error) {
      if (!(error instanceof S3ServiceException) || ![400, 501].includes(error.$metadata.httpStatusCode ?? 0)) throw error;
    }
  }
  if (bucket.expireDays !== undefined) await client.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket.name,
    LifecycleConfiguration: { Rules: [{ ID: "expire-quarantine", Status: "Enabled", Filter: { Prefix: "" }, Expiration: { Days: bucket.expireDays }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }] },
  }));
}
client.destroy();
