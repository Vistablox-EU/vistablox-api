import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { IssueDeviceChallengeService } from "../application/device-challenge-issuance.service.js";
import type { AuthorizeSigningRequestService } from "../application/authorize-signing-request.service.js";
import type { SigningRequestRepository } from "../repository/signing-request.repository.js";
import {
  SIGNING_REQUEST_STATUS_CANCELLED,
  SIGNING_REQUEST_STATUS_EXPIRED,
  SIGNING_REQUEST_STATUS_PENDING,
  type SigningRequestStatus,
} from "../domain/signing-request.policy.js";
import type { DeviceRepository } from "../repository/device.repository.js";
import {
  DeviceChallengeExpiredError,
  DeviceChallengeReplayedError,
} from "../application/device-auth-errors.js";
import {
  SigningRequestAlreadyConsumedError,
  SigningRequestCancelledError,
  SigningRequestExpiredError,
  SigningRequestNotFoundError,
  TxFieldMismatchError,
  TxSignatureInvalidError,
  TxWrongDeviceError,
} from "../application/signing-request-errors.js";
import {
  signingChallengeRequestSchema,
  signingChallengeResponseSchema,
  signingRequestParamsSchema,
  signingRequestResponseSchema,
  signingRequestsListQuerySchema,
  signingRequestsListResponseSchema,
  signingSignRequestSchema,
  signingSignResponseSchema,
} from "./signing-requests.schemas.js";
import type { AuthContext } from "./auth-context.js";

const TX_CHALLENGE_TTL_SECONDS = 120;

/**
 * `/v1/auth/signing-requests/*` (T1-T3). The routes differ from the
 * device-auth enrolment/login family: they sit behind requireAuthentication
 * (a device-bound session), not the DPoP-only proof middleware, because the
 * actor is an already-authenticated account whose device signs an action,
 * not an anonymous enrollement.
 *
 * The T3 response can answer `signed` alongside the contract's
 * `submitted|executed`: `submitted`/`included` are the on-chain bundler path
 * (future phases), `executed` means the off-chain action actually ran, and
 * `signed` is the honest terminal this phase reaches -- no request-type
 * executors are registered yet, so nothing has executed. Phase 2's route
 * cut-over registers executors and the same corridor starts answering
 * `executed`. Both plan docs note this under their shared wire contract.
 */
export function createSigningRequestsRouter(input: {
  requireAuthentication: RequestHandler;
  issues: IssueDeviceChallengeService;
  devices: Pick<DeviceRepository, "findByDpopJkt">;
  requests: SigningRequestRepository;
  authorizes: AuthorizeSigningRequestService;
}): Router {
  const router = Router();
  router.use(input.requireAuthentication);

  // T1 list: the account's signing requests, newest first. `?status=` is
  // optional and defaults to `pending`, the actionable inbox.
  router.get("/", async (request, response) => {
    try {
      const query = signingRequestsListQuerySchema.parse(request.query);
      const { accountId } = authContext(response);
      const status = query.status ?? SIGNING_REQUEST_STATUS_PENDING;
      const rows = await input.requests.listForAccount(accountId, status);
      response.json(signingRequestsListResponseSchema.parse({ data: rows.map(toRequestObject) }));
    } catch (error) {
      throw toAppError(error);
    }
  });

  // T1 fetch: one request, owned by this account.
  router.get("/:request_id", async (request, response) => {
    try {
      const params = signingRequestParamsSchema.parse(request.params);
      const { accountId } = authContext(response);
      const row = await input.requests.findOwned(params.request_id, accountId);
      if (row === null) {
        throw new SigningRequestNotFoundError();
      }
      response.json(signingRequestResponseSchema.parse({ data: toRequestObject(row) }));
    } catch (error) {
      throw toAppError(error);
    }
  });

  // T2: a fresh single-use `tx` challenge bound to the session's device and
  // to this request. The device is resolved from the session's DPoP key
  // (contract 3.1); a challenge is refused if the request isn't this
  // device's own, pending, and unexpired.
  router.post("/:request_id/challenge", async (request, response) => {
    try {
      const params = signingRequestParamsSchema.parse(request.params);
      const { accountId, dpopJkt = missingDpopJkt() } = authContext(response);
      signingChallengeRequestSchema.parse(request.body ?? {});
      const row = await input.requests.findOwned(params.request_id, accountId);
      if (row === null) {
        throw new SigningRequestNotFoundError();
      }
      const device = await input.devices.findByDpopJkt(dpopJkt);
      if (device === null || device.deviceId !== row.deviceId) {
        throw new TxWrongDeviceError();
      }
      assertRequestChallengeable(row);
      const { challenge, expiresAt } = await input.issues.execute({
        purpose: "tx",
        dpopJkt,
        deviceId: device.deviceId,
        ttlSeconds: TX_CHALLENGE_TTL_SECONDS,
      });
      response.json(
        signingChallengeResponseSchema.parse({
          data: { challenge, expires_at: expiresAt.toISOString() },
        }),
      );
    } catch (error) {
      throw toAppError(error);
    }
  });

  // T3: sign the request (off-chain types). The device JWS proves knowledge
  // of both the DPoP key and the biometric key; the service spirals the
  // challenge, verifies the signature, and compares the tx claims field by
  // field before atomically marking the request `signed`.
  router.post("/:request_id/sign", async (request, response) => {
    try {
      const params = signingRequestParamsSchema.parse(request.params);
      const { accountId, dpopJkt = missingDpopJkt() } = authContext(response);
      const body = signingSignRequestSchema.parse(request.body);
      const signed = await input.authorizes.execute({
        requestId: params.request_id,
        accountId,
        dpopJkt,
        challenge: body.challenge,
        jws: body.jws,
      });
      response.json(
        signingSignResponseSchema.parse({
          data: { status: signed.status as SigningRequestStatus },
        }),
      );
    } catch (error) {
      throw toAppError(error);
    }
  });

  return router;
}

function authContext(response: import("express").Response): AuthContext {
  const auth = response.locals.authContext;
  if (auth === undefined) {
    throw new AppError({
      code: "internal.auth_context_missing",
      title: "Internal server error",
      status: 500,
      detail: "requireAuthentication ran but left no auth context for the handler to use.",
    });
  }
  return auth as AuthContext;
}

function missingDpopJkt(): never {
  throw new AppError({
    code: "internal.dpop_jkt_missing",
    title: "Internal server error",
    status: 500,
    detail: "The authenticated session carried no DPoP binding; nothing to sign with.",
  });
}

function assertRequestChallengeable(row: { status: string; expiresAt: Date }): void {
  switch (row.status) {
    case SIGNING_REQUEST_STATUS_PENDING:
      // Lazy expiry: T2 is refused once the stored expiry has passed, even
      // before the hourly prune rewrites the status.
      if (row.expiresAt.getTime() < Date.now()) {
        throw new SigningRequestExpiredError();
      }
      return;
    case SIGNING_REQUEST_STATUS_EXPIRED:
      throw new SigningRequestExpiredError();
    case SIGNING_REQUEST_STATUS_CANCELLED:
      throw new SigningRequestCancelledError();
    default:
      throw new SigningRequestAlreadyConsumedError();
  }
}

import type { TxDestination } from "../domain/signing-request.policy.js";

function toRequestObject(row: {
  id: string;
  requestType: string;
  amountMinor: string | null;
  currency: string | null;
  destination: TxDestination | null;
  createdBy: { kind: string; label: string };
  status: string;
  signedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}): {
  request_id: string;
  request_type: string;
  amount_minor: string | null;
  currency: string | null;
  destination: { kind: string; value: string; display_name?: string } | null;
  created_by: { kind: string; label: string };
  created_at: string;
  expires_at: string;
  status: string;
} {
  return {
    request_id: row.id,
    request_type: row.requestType,
    amount_minor: row.amountMinor,
    currency: row.currency,
    destination:
      row.destination === null
        ? null
        : {
            kind: row.destination.kind,
            value: row.destination.value,
            ...(row.destination.displayName === undefined
              ? {}
              : { display_name: row.destination.displayName }),
          },
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    status: row.status,
  };
}

/**
 * Shape the signing-request error classes and Zod failures into the /v1
 * problem+json envelope. The domain/service layer keeps its codes as Error
 * classes (like the device-auth family); this router is the HTTP boundary,
 * so it owns the mapping. TX_FIELD_MISMATCH additionally reports the
 * offending field so the client can tell the user exactly what changed.
 */
function toAppError(error: unknown): unknown {
  if (error instanceof SigningRequestNotFoundError) {
    return new AppError({
      code: error.code,
      title: "Signing request not found",
      status: 404,
      detail: error.message,
      cause: error,
    });
  }
  if (error instanceof SigningRequestExpiredError) {
    return new AppError({
      code: error.code,
      title: "Signing request expired",
      status: 409,
      detail: error.message,
      cause: error,
    });
  }
  if (error instanceof SigningRequestCancelledError) {
    return new AppError({
      code: error.code,
      title: "Signing request cancelled",
      status: 409,
      detail: error.message,
      cause: error,
    });
  }
  if (error instanceof SigningRequestAlreadyConsumedError) {
    return new AppError({
      code: error.code,
      title: "Signing request already consumed",
      status: 409,
      detail: error.message,
      cause: error,
    });
  }
  if (error instanceof TxWrongDeviceError) {
    return new AppError({
      code: error.code,
      title: "Wrong signing device",
      status: 403,
      detail: error.message,
      cause: error,
    });
  }
  if (error instanceof TxSignatureInvalidError) {
    return new AppError({
      code: error.code,
      title: "Transaction signature invalid",
      status: 401,
      detail: error.message,
      cause: error,
    });
  }
  if (error instanceof TxFieldMismatchError) {
    return new AppError({
      code: error.code,
      title: "Signed transaction fields differ from the stored request",
      status: 409,
      detail: `The signed request's ${error.field} does not match what was stored.`,
      cause: error,
    });
  }
  if (
    error instanceof DeviceChallengeExpiredError ||
    error instanceof DeviceChallengeReplayedError
  ) {
    return new AppError({
      code: error.code,
      title: "Challenge unavailable",
      status: 400,
      detail: error.message,
      cause: error,
    });
  }
  // AppError and ZodError pass through to the global handler unchanged; the
  // internal.* errors thrown above are AppErrors already.
  return error;
}