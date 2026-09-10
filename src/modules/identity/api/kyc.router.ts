import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  GetKycStatusService,
  ReceiveDiditWebhookService,
  StartKycSessionService,
  StartProofOfAddressSessionService,
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

// Calls the concrete application services directly, in-process. This
// router's own job: enforce the customer session, validate the request
// shape, translate to/from the response schemas. Security-critical: every
// accountId below comes from requireCustomerContext(response.locals.authContext)
// -- the verified session -- never from client-supplied input. Contrast
// kyc-operations.router.ts's account_id-from-path-param shape, which is
// only safe there because that route is staff-only and already
// WebAuthn-gated.
export function createKycRouter(
  requireAuthentication: RequestHandler,
  getStatus: GetKycStatusService,
  startSession: StartKycSessionService,
  startProofOfAddressSession: StartProofOfAddressSessionService | undefined,
): Router {
  const router = Router();
  router.get("/", requireAuthentication, async (_request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const result = await getStatus.execute(context.accountId);
    response.setHeader("Cache-Control", "no-store");
    response.json(kycStatusResponseSchema.parse(result));
  });
  router.post("/sessions", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const body = startKycSessionBodySchema.parse(request.body);
    const result = await startSession.execute({
      accountId: context.accountId,
      traceId: String(response.locals.traceId),
      residenceCountryCode: body.residence_country_code,
      taxResidenceCountryCode: body.tax_residence_country_code,
      ...(body.language === undefined ? {} : { language: body.language }),
    });
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(startKycSessionResponseSchema.parse(result));
  });
  // Always mounted, matching the pre-reversal behavior: an unconfigured
  // deployment (no DIDIT_POA_WORKFLOW_ID) reports a structured error from
  // this handler instead of the route simply not existing -- a better API
  // contract on its own merits (the endpoint's existence doesn't depend on
  // server config, only its outcome does), independent of the original,
  // now-moot reason this was chosen (keeping two separate processes'
  // startup independent).
  router.post(
    "/proof-of-address/sessions",
    requireAuthentication,
    async (request, response) => {
      const context = requireCustomerContext(response.locals.authContext);
      const body = startProofOfAddressSessionBodySchema.parse(request.body);
      if (startProofOfAddressSession === undefined) {
        throw proofOfAddressNotConfiguredError();
      }
      const result = await startProofOfAddressSession.execute({
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

function proofOfAddressNotConfiguredError(): AppError {
  return new AppError({
    code: "identity.proof_of_address_not_configured",
    title: "Not found",
    status: 404,
    detail: "Proof of address verification is not configured.",
  });
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
  context: Express.Locals["authContext"],
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
