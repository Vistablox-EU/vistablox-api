import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CompleteAccountRecoveryService,
  CreateRecoveryDiditSessionService,
  DecideAccountRecoveryCaseService,
  GetAccountRecoveryCaseService,
  OpenAccountRecoveryCaseService,
  RecordPrimaryRecoveryReviewService,
} from "../application/account-recovery.service.js";
import type {
  AccountRecoveryCaseRecord,
  RecoveryCorroborationFacts,
} from "../repository/account-recovery.repository.js";
import {
  accountRecoveryCaseParamsSchema,
  accountRecoveryCaseResponseSchema,
  completeAccountRecoveryBodySchema,
  createRecoveryDiditSessionBodySchema,
  createRecoveryDiditSessionResponseSchema,
  decideAccountRecoveryCaseBodySchema,
  getAccountRecoveryCaseResponseSchema,
  openAccountRecoveryCaseBodySchema,
  recordPrimaryRecoveryReviewBodySchema,
} from "./account-recovery.schemas.js";

export function createAccountRecoveryRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  openCase: OpenAccountRecoveryCaseService,
  createDiditSession: CreateRecoveryDiditSessionService,
  getCase: GetAccountRecoveryCaseService,
  recordPrimaryReview: RecordPrimaryRecoveryReviewService,
  decideCase: DecideAccountRecoveryCaseService,
  completeRecovery: CompleteAccountRecoveryService,
): Router {
  const router = Router();
  const authorization = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.post("/", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const body = openAccountRecoveryCaseBodySchema.parse(request.body);
    const result = await openCase.execute({
      accountId: body.account_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.status(201).json(accountRecoveryCaseResponseSchema.parse({ data: toCasePayload(result) }));
  });

  router.get("/:case_id", ...authorization, async (request, response) => {
    const params = accountRecoveryCaseParamsSchema.parse(request.params);
    const result = await getCase.execute(params.case_id);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      getAccountRecoveryCaseResponseSchema.parse({
        data: {
          case: toCasePayload(result.case),
          fresh_didit_verification_status: result.freshDiditVerificationStatus,
          corroboration_facts: toFactsPayload(result.corroborationFacts),
        },
      }),
    );
  });

  router.post("/:case_id/didit-sessions", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = accountRecoveryCaseParamsSchema.parse(request.params);
    createRecoveryDiditSessionBodySchema.parse(request.body ?? {});
    const result = await createDiditSession.execute({
      caseId: params.case_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.status(201).json(
      createRecoveryDiditSessionResponseSchema.parse({
        data: { verification_url: result.verificationUrl, case: toCasePayload(result.case) },
      }),
    );
  });

  router.post("/:case_id/primary-review", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = accountRecoveryCaseParamsSchema.parse(request.params);
    const body = recordPrimaryRecoveryReviewBodySchema.parse(request.body);
    const result = await recordPrimaryReview.execute({
      caseId: params.case_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      corroborationCategory: body.corroboration_category,
    });
    response.json(accountRecoveryCaseResponseSchema.parse({ data: toCasePayload(result) }));
  });

  router.post("/:case_id/decision", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = accountRecoveryCaseParamsSchema.parse(request.params);
    const body = decideAccountRecoveryCaseBodySchema.parse(request.body);
    const result = await decideCase.execute({
      caseId: params.case_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
      decision: body.decision,
      reason: body.reason,
    });
    response.json(accountRecoveryCaseResponseSchema.parse({ data: toCasePayload(result) }));
  });

  router.post("/:case_id/complete", ...authorization, async (request, response) => {
    const authContext = response.locals.authContext;
    if (authContext === undefined) throw missingContextError();
    const params = accountRecoveryCaseParamsSchema.parse(request.params);
    completeAccountRecoveryBodySchema.parse(request.body ?? {});
    const result = await completeRecovery.execute({
      caseId: params.case_id,
      actorAccountId: authContext.accountId,
      traceId: String(response.locals.traceId),
    });
    response.status(202).json(accountRecoveryCaseResponseSchema.parse({ data: toCasePayload(result) }));
  });

  return router;
}

function toCasePayload(record: AccountRecoveryCaseRecord) {
  return {
    recovery_case_id: record.id,
    account_id: record.accountId,
    status: record.status,
    fresh_didit_verification_ref: record.freshDiditVerificationRef,
    reviewed_by_primary: record.reviewedByPrimary,
    reviewed_by_secondary: record.reviewedBySecondary,
    cooldown_ends_at: record.cooldownEndsAt?.toISOString() ?? null,
    created_at: record.createdAt.toISOString(),
    resolved_at: record.resolvedAt?.toISOString() ?? null,
  };
}

function toFactsPayload(facts: RecoveryCorroborationFacts) {
  return {
    last_deposit:
      facts.lastDeposit === null
        ? null
        : { amount_eur: facts.lastDeposit.amountEur, recorded_at: facts.lastDeposit.recordedAt.toISOString() },
    last_reservation:
      facts.lastReservation === null
        ? null
        : {
            amount_eur: facts.lastReservation.amountEur,
            created_at: facts.lastReservation.createdAt.toISOString(),
          },
    last_login:
      facts.lastLogin === null
        ? null
        : { auth_method: facts.lastLogin.authMethod, occurred_at: facts.lastLogin.occurredAt.toISOString() },
  };
}

function missingContextError(): AppError {
  return new AppError({
    code: "authentication.context_missing",
    title: "Authentication unavailable",
    status: 500,
    detail: "The authenticated account context is unavailable.",
  });
}
