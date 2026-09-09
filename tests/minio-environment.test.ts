import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-test-secret-that-is-long-enough",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "no-reply@example.com",
  KYC_SERVICE_URL: "http://vistablox-kyc:3000",
  INTERNAL_KYC_API_SECRET: "an-internal-kyc-api-secret-value-32-chars",
};

describe("MinIO environment", () => {
  it("keeps document storage optional for non-storage test processes", () => {
    expect(loadEnvironment(base).MINIO_ENDPOINT).toBeUndefined();
  });

  it("accepts a complete private object-storage configuration", () => {
    expect(
      loadEnvironment({
        ...base,
        MINIO_ENDPOINT: "minio",
        MINIO_PORT: "9000",
        MINIO_USE_SSL: "false",
        MINIO_ACCESS_KEY: "access-key",
        MINIO_SECRET_KEY: "secret-key",
        MINIO_DOCUMENT_BUCKET: "vistablox-documents",
      }),
    ).toMatchObject({
      MINIO_ENDPOINT: "minio",
      MINIO_PORT: 9000,
      MINIO_USE_SSL: false,
      MINIO_DOCUMENT_BUCKET: "vistablox-documents",
    });
  });

  it("rejects a partial object-storage configuration", () => {
    expect(() =>
      loadEnvironment({ ...base, MINIO_ENDPOINT: "minio" }),
    ).toThrow("All MinIO document storage settings must be configured together");
  });
});
