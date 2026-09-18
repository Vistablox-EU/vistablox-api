import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createIntakeOperationsRouter } from "../src/modules/intake/api/intake-operations.router.js";
import { GetOperationsReadinessService } from "../src/modules/intake/application/get-operations-readiness.service.js";
import type { GetCaseDocumentService } from "../src/modules/intake/application/get-case-document.service.js";
import type { OperationsReadinessSnapshot } from "../src/modules/intake/repository/intake.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const snapshot: OperationsReadinessSnapshot = {
  caseId: "case_01",
  stage: "draft",
  submission: null,
  legalPracticeId: null,
  legalStructuringCompletedAt: null,
  appraisalFirmId: null,
  appraisalCompletedAt: null,
  founder: {
    reviewedByAccountId: null,
    approvedAt: null,
    rejectedAt: null,
    ipoPeriodDays: null,
    ipoValueEur: null,
    ipoEndAt: null,
  },
  offering: null,
};

function app(
  options: {
    authenticated?: boolean;
    admin?: boolean;
    webauthn?: boolean;
    record?: OperationsReadinessSnapshot | null;
    documentDownload?: GetCaseDocumentService;
  } = {},
) {
  const gate =
    (enabled: boolean, code: string, status: number): RequestHandler =>
    (_request, _response, next) =>
      enabled
        ? next()
        : next(
            new AppError({
              code,
              title: "Denied",
              status,
              detail: "Denied for test.",
            }),
          );
  const readiness = new GetOperationsReadinessService(
    {
      getOperationsReadiness: vi
        .fn()
        .mockResolvedValue(
          options.record === undefined ? snapshot : options.record,
        ),
    },
    () => new Date("2026-09-16T12:00:00.000Z"),
  );
  const server = express();
  server.use(requestContext);
  server.use(
    "/internal/v1/intake-cases",
    createIntakeOperationsRouter(
      gate(options.authenticated ?? true, "authentication.required", 401),
      gate(options.admin ?? true, "authorization.forbidden", 403),
      gate(
        options.webauthn ?? true,
        "authentication.staff_webauthn_required",
        403,
      ),
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      readiness,
      undefined,
      options.documentDownload,
    ),
  );
  server.use(errorHandler);
  return server;
}

describe("GET /internal/v1/intake-cases/:case_id/readiness", () => {
  it("returns the schema-validated snapshot with nullable sections", async () => {
    const response = await request(app()).get(
      "/internal/v1/intake-cases/case_01/readiness",
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: {
        case_id: "case_01",
        evaluated_at: "2026-09-16T12:00:00.000Z",
        linked_offering: null,
        disclosure_pack: null,
        funding: null,
      },
    });
  });

  it.each([
    ["authenticated", 401],
    ["admin", 403],
    ["webauthn", 403],
  ] as const)("enforces %s", async (field, status) => {
    const response = await request(app({ [field]: false })).get(
      "/internal/v1/intake-cases/case_01/readiness",
    );
    expect(response.status).toBe(status);
  });

  it("returns the established 404 for an unknown case", async () => {
    const response = await request(app({ record: null })).get(
      "/internal/v1/intake-cases/missing/readiness",
    );
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("intake.case_not_found");
  });

  it("does not emit malformed repository data", async () => {
    const response = await request(
      app({ record: { ...snapshot, stage: "not_a_case_stage" } }),
    ).get("/internal/v1/intake-cases/case_01/readiness");
    expect(response.status).toBe(422);
  });
});

describe("case document streaming", () => {
  it("sends object bytes as an image rather than JSON-encoding the Uint8Array", async () => {
    const server = app({
      documentDownload: {
        execute: vi.fn().mockResolvedValue({
          body: { transformToByteArray: async () => new Uint8Array([137, 80, 78, 71]) },
          contentType: "image/png",
          sizeBytes: 4,
        }),
        list: vi.fn().mockResolvedValue([]),
      } as unknown as GetCaseDocumentService,
    });
    const response = await request(server).get(
      "/internal/v1/intake-cases/case_01/documents?document_ref=intake%2Fcase_01%2Fphoto.png",
    );
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual(Buffer.from([137, 80, 78, 71]));
  });
});
