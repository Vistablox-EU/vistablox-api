import { Router } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  GetKycAccountForOperationsService,
  GetKycStatusService,
  StartKycSessionService,
  StartProofOfAddressSessionService,
} from "../application/kyc.service.js";
import type { InternalApiSignatureVerifier } from "../infrastructure/internal-api-signature.js";
import {
  internalKycStatusQuerySchema,
  internalStartKycSessionBodySchema,
  internalStartProofOfAddressSessionBodySchema,
} from "./kyc-internal.schemas.js";
import {
  kycAccountIdParamsSchema,
  kycStatusResponseSchema,
  operationsKycAccountResponseSchema,
  startKycSessionResponseSchema,
  startProofOfAddressSessionResponseSchema,
} from "./kyc.schemas.js";

// vistablox-kyc's internal-only counterpart to kyc.router.ts/
// kyc-operations.router.ts -- reached only by vistablox-api's
// HttpKycServiceClient over the compose-internal network, never intended to
// be called directly by an external client. Auth is entirely different from
// the customer-facing routes: there is no Better Auth session, no WebAuthn,
// no response.locals.authContext here -- vistablox-api already did all of
// that before calling in, so the only thing this layer verifies is that the
// caller genuinely is vistablox-api (the signature below), and accountId/
// traceId are read from the request itself, validated like any other
// untrusted input.
export function createKycInternalRouter(
  verifier: InternalApiSignatureVerifier,
  getStatus: GetKycStatusService,
  startSession: StartKycSessionService,
  startProofOfAddressSession: StartProofOfAddressSessionService | undefined,
  getAccountForOperations: GetKycAccountForOperationsService,
): Router {
  const router = Router();

  router.use((request, _response, next) => {
    try {
      verifier.verify({
        method: request.method,
        path: request.originalUrl,
        body: request.method === "GET" ? undefined : request.body,
        signature: readHeader(request.headers["x-internal-signature"]),
        timestamp: readHeader(request.headers["x-internal-timestamp"]),
      });
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/status", async (request, response) => {
    const query = internalKycStatusQuerySchema.parse(request.query);
    const result = await getStatus.execute(query.account_id);
    response.json(kycStatusResponseSchema.parse(result));
  });

  router.post("/sessions", async (request, response) => {
    const body = internalStartKycSessionBodySchema.parse(request.body);
    const result = await startSession.execute({
      accountId: body.account_id,
      traceId: body.trace_id,
      residenceCountryCode: body.residence_country_code,
      taxResidenceCountryCode: body.tax_residence_country_code,
      ...(body.language === undefined ? {} : { language: body.language }),
    });
    response.status(201).json(startKycSessionResponseSchema.parse(result));
  });

  // Always mounted, even when this deployment has no proof-of-address
  // workflow configured -- keeps vistablox-api's own /v1/kyc/proof-of-
  // address/sessions route mountable unconditionally too, with no
  // synchronous capability probe or cross-service depends_on between the
  // two processes' startup. Reports the same "not available" outcome as
  // today's bare 404 (the route not existing at all when unconfigured),
  // just as a structured error body instead.
  router.post("/proof-of-address/sessions", async (request, response) => {
    if (startProofOfAddressSession === undefined) {
      throw proofOfAddressNotConfiguredError();
    }
    const body = internalStartProofOfAddressSessionBodySchema.parse(request.body);
    const result = await startProofOfAddressSession.execute({
      accountId: body.account_id,
      traceId: body.trace_id,
      ...(body.language === undefined ? {} : { language: body.language }),
    });
    response.status(201).json(startProofOfAddressSessionResponseSchema.parse(result));
  });

  router.get("/accounts/:account_id", async (request, response) => {
    const params = kycAccountIdParamsSchema.parse(request.params);
    const result = await getAccountForOperations.execute(params.account_id);
    response.json(operationsKycAccountResponseSchema.parse(result));
  });

  return router;
}

function proofOfAddressNotConfiguredError(): AppError {
  return new AppError({
    code: "identity.proof_of_address_not_configured",
    title: "Not found",
    status: 404,
    detail: "Proof of address verification is not configured.",
  });
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
