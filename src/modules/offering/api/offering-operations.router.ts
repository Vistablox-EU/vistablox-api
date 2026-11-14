import { pipeline } from "node:stream/promises";

import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { ClassifyMaterialityService } from "../application/classify-materiality.service.js";
import type { FinalizeOfferingService } from "../application/finalize-offering.service.js";
import type { GetOfferingDocumentService } from "../application/get-offering-document.service.js";
import type { PublishDisclosurePackService } from "../application/publish-disclosure-pack.service.js";
import type { UploadOfferingDocumentService } from "../application/upload-offering-document.service.js";
import { investorOfferingParamsSchema } from "./offering.schemas.js";
import {
  classifyMaterialityBodySchema,
  classifyMaterialityResponseSchema,
  finalizeOfferingBodySchema,
  finalizeOfferingResponseSchema,
  listOfferingDocumentsResponseSchema,
  offeringDocumentsQuerySchema,
  publishDisclosurePackBodySchema,
  publishDisclosurePackResponseSchema,
  uploadOfferingDocumentResponseSchema,
} from "./offering-operations.schemas.js";

export interface OfferingDocumentServices {
  upload: UploadOfferingDocumentService;
  read: GetOfferingDocumentService;
}

export function createOfferingOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  finalizeOffering: FinalizeOfferingService,
  classifyMateriality: ClassifyMaterialityService,
  publishDisclosurePack: PublishDisclosurePackService,
  requireFinalizeIdempotency?: RequestHandler,
  // Only present once document storage (MINIO_* + MINIO_DISCLOSURES_BUCKET)
  // is configured, the same way intake's upload routes are. See server.ts.
  documents?: OfferingDocumentServices,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.post(
    "/:offering_id/finalize",
    ...staffOnly,
    ...(requireFinalizeIdempotency === undefined ? [] : [requireFinalizeIdempotency]),
    async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = investorOfferingParamsSchema.parse(request.params);
    const body = finalizeOfferingBodySchema.parse(request.body);
    const result = await finalizeOffering.execute({
      accountId: authContext.accountId,
      offeringId: params.offering_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.json(finalizeOfferingResponseSchema.parse(result));
  });

  router.post("/:offering_id/materiality-records", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = investorOfferingParamsSchema.parse(request.params);
    const body = classifyMaterialityBodySchema.parse(request.body);
    const result = await classifyMateriality.execute({
      accountId: authContext.accountId,
      offeringId: params.offering_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(201).json(classifyMaterialityResponseSchema.parse(result));
  });

  router.post("/:offering_id/disclosure-packs", ...staffOnly, async (request, response) => {
    const authContext = requireAuthContext(response.locals.authContext);
    const params = investorOfferingParamsSchema.parse(request.params);
    const body = publishDisclosurePackBodySchema.parse(request.body);
    const result = await publishDisclosurePack.execute({
      accountId: authContext.accountId,
      offeringId: params.offering_id,
      traceId: String(response.locals.traceId),
      body,
    });
    response.status(201).json(publishDisclosurePackResponseSchema.parse(result));
  });

  if (documents !== undefined) {
    // Raw file body, described by headers: the admin posts the file itself,
    // not a multipart form, exactly like intake's POST /:case_id/documents.
    router.post("/:offering_id/documents", ...staffOnly, async (request, response) => {
      const authContext = requireAuthContext(response.locals.authContext);
      const params = investorOfferingParamsSchema.parse(request.params);
      const result = await documents.upload.execute({
        offeringId: params.offering_id,
        documentType: String(request.header("x-document-type") ?? "").trim(),
        body: request,
        contentType: (request.header("content-type")?.split(";", 1)[0] ?? "application/octet-stream").trim().toLowerCase(),
        originalFilename: decodeOriginalFilename(request.header("x-original-filename")),
        actorAccountId: authContext.accountId,
        traceId: String(response.locals.traceId),
      });
      response.status(201).json(uploadOfferingDocumentResponseSchema.parse(result));
    });

    router.get("/:offering_id/documents", ...staffOnly, async (request, response) => {
      const params = investorOfferingParamsSchema.parse(request.params);
      const query = offeringDocumentsQuerySchema.parse(request.query);
      if (query.document_ref === undefined) {
        const result = await documents.read.list({
          offeringId: params.offering_id,
          ...(query.document_type === undefined ? {} : { documentType: query.document_type }),
        });
        response.json(listOfferingDocumentsResponseSchema.parse(result));
        return;
      }
      const download = await documents.read.download({ offeringId: params.offering_id, documentRef: query.document_ref });
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("Content-Type", download.contentType);
      response.setHeader("Content-Length", String(download.contentLength));
      response.setHeader("Content-Disposition", `inline; filename="${contentDispositionFileName(download.fileName)}"`);
      response.setHeader("X-Content-Type-Options", "nosniff");
      await pipeline(download.body, response);
    });
  }

  return router;
}

/**
 * X-Original-Filename is a header, so the admin percent-encodes anything a
 * header cannot carry. A value without `%` is taken verbatim; one with `%`
 * is decoded, falling back to the raw value when it is not valid encoding.
 */
export function decodeOriginalFilename(header: string | undefined): string {
  const raw = (header ?? "").trim();
  if (raw.length === 0) return "document";
  let decoded = raw;
  if (raw.includes("%")) {
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
  }
  const trimmed = decoded.trim().slice(0, 255);
  return trimmed.length === 0 ? "document" : trimmed;
}

function contentDispositionFileName(value: string): string {
  const safe = value
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "disclosure-document";
}

function requireAuthContext(authContext: Express.Locals["authContext"]) {
  if (authContext === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  return authContext;
}
