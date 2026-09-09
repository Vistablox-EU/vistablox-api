import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { KycServiceGateway } from "../application/kyc-service-gateway.js";
import {
  ReceiveDiditWebhookService,
} from "../application/kyc.service.js";
import { DiditWebhookVerifier } from "../infrastructure/didit-webhook-verifier.js";
import {
  diditWebhookBodySchema,
  diditWebhookResponseSchema,
  kycStatusResponseSchema,
  startProofOfAddressSessionBodySchema,
  startProofOfAddressSessionResponseSchema,
  startKycSessionBodySchema,
  startKycSessionResponseSchema,
} from "./kyc.schemas.js";

// KycServiceGateway forwards to vistablox-kyc, where KycEligibility (and
// StartKycSessionService/GetKycStatusService/etc.) now actually live -- this
// router's own job is unchanged: enforce the customer session, validate the
// request shape, and translate to/from the gateway's already-matching
// response schemas.
export function createKycRouter(
  requireAuthentication: RequestHandler,
  gateway: KycServiceGateway,
): Router {
  const router = Router();
  router.get("/", requireAuthentication, async (_request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const result = await gateway.getStatus(context.accountId);
    response.setHeader("Cache-Control", "no-store");
    response.json(kycStatusResponseSchema.parse(result));
  });
  router.post("/sessions", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const body = startKycSessionBodySchema.parse(request.body);
    const result = await gateway.startSession({
      accountId: context.accountId,
      traceId: String(response.locals.traceId),
      residenceCountryCode: body.residence_country_code,
      taxResidenceCountryCode: body.tax_residence_country_code,
      ...(body.language === undefined ? {} : { language: body.language }),
    });
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(startKycSessionResponseSchema.parse(result));
  });
  // Always mounted now, unlike the old optional-third-argument shape --
  // vistablox-api has no local visibility into whether vistablox-kyc has a
  // proof-of-address workflow configured. An unconfigured deployment
  // reports a structured error from the gateway call itself instead of this
  // route simply not existing (see kyc-internal.router.ts).
  router.post(
    "/proof-of-address/sessions",
    requireAuthentication,
    async (request, response) => {
      const context = requireCustomerContext(response.locals.authContext);
      const body = startProofOfAddressSessionBodySchema.parse(request.body);
      const result = await gateway.startProofOfAddressSession({
        accountId: context.accountId,
        traceId: String(response.locals.traceId),
        ...(body.language === undefined ? {} : { language: body.language }),
      });
      response.setHeader("Cache-Control", "no-store");
      response
        .status(201)
        .json(startProofOfAddressSessionResponseSchema.parse(result));
    },
  );
  return router;
}

export function createDiditWebhookRouter(
  verifier: DiditWebhookVerifier,
  receiveWebhook: ReceiveDiditWebhookService,
): Router {
  const router = Router();
  router.post("/", async (request, response) => {
    verifier.verify({
      body: request.body,
      signature: readHeader(request.headers["x-signature-v2"]),
      timestamp: readHeader(request.headers["x-timestamp"]),
    });
    const body = diditWebhookBodySchema.parse(request.body);
    const result = await receiveWebhook.execute({
      eventId: body.event_id,
      webhookType: body.webhook_type,
      applicationId: body.application_id,
      environment: body.environment,
      sessionId: body.session_id,
      sessionKind: body.session_kind ?? null,
      workflowId: body.workflow_id ?? null,
      vendorData: body.vendor_data ?? null,
      status: body.status,
      createdAt: body.created_at,
      traceId: String(response.locals.traceId),
    });
    response.json(diditWebhookResponseSchema.parse(result));
  });
  return router;
}

function requireCustomerContext(
  context: { accountId: string; population: string } | undefined,
): { accountId: string } {
  if (context === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  if (context.population !== "customer") {
    throw new AppError({
      code: "authorization.forbidden",
      title: "Action not permitted",
      status: 403,
      detail: "Individual KYC is available only to customer accounts.",
    });
  }
  return { accountId: context.accountId };
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
