import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-test-secret-that-is-long-enough",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "no-reply@example.com",
  DIDIT_API_KEY: "key",
  DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
  DIDIT_WEBHOOK_SECRET: "a-didit-webhook-secret-value-32-chars",
  DIDIT_APPLICATION_ID: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  DIDIT_ENVIRONMENT: "sandbox",
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
