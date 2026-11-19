import type { Request, RequestHandler, Response } from "express";

import type { IdempotencyStore } from "../../../infrastructure/idempotency/idempotency-store.js";
import { AppError } from "../../../shared/errors/app-error.js";
import { createIdempotencyMiddleware } from "../../../shared/http/idempotency.js";

// AD-057/AD-147: the high-risk writes that exist are reservation funding
// initiation (creating a hold, and starting a payment session for one),
// investor reconfirmation submission, and the finalization-batch action. Each
// mounts the shared Idempotency-Key middleware with a stable endpoint
// identifier of its own, keyed on the same audit.idempotency_keys table.
// Refunds, payouts, reservation cancellation and legal direct-contact release
// are future work and will mount the same middleware when they land.
//
// Each mount also names its request scope. The table's key is only
// (key, endpoint), so what the key was used for (which account, which
// offering or reservation) is part of the request fingerprint: another
// account, or another resource, under the same key is a 409, never a replay of
// somebody else's stored response.

// Fails closed: a mount placed before authentication would otherwise drop the
// account from the scope and let every account share one.
function scopedTo(...pathParameters: string[]): (request: Request, response: Response) => string {
  return (request, response) => {
    const accountId = response.locals.authContext?.accountId;
    if (accountId === undefined) {
      throw new AppError({
        code: "authentication.context_missing",
        title: "Authentication unavailable",
        status: 500,
        detail: "The authenticated account context is unavailable.",
      });
    }
    return JSON.stringify([accountId, ...pathParameters.map((name) => String(request.params[name] ?? ""))]);
  };
}

export interface OfferingIdempotency {
  /** POST /v1/offerings/:offering_id/reservations */
  createReservation: RequestHandler;
  /** POST /v1/offerings/:offering_id/reservations/:reservation_id/reconfirm */
  reconfirmReservation: RequestHandler;
  /** POST /v1/offerings/:offering_id/reservations/:reservation_id/payment-session */
  paymentSession: RequestHandler;
  /** POST /internal/v1/offerings/:offering_id/finalize */
  finalize: RequestHandler;
}

export function createOfferingIdempotency(store: IdempotencyStore): OfferingIdempotency {
  const clock = () => new Date();
  return {
    createReservation: createIdempotencyMiddleware(store, "offering.reservation.create", clock, {
      scope: scopedTo("offering_id"),
    }),
    reconfirmReservation: createIdempotencyMiddleware(store, "offering.reservation.reconfirm", clock, {
      scope: scopedTo("offering_id", "reservation_id"),
    }),
    paymentSession: createIdempotencyMiddleware(store, "offering.reservation.payment_session", clock, {
      scope: scopedTo("offering_id", "reservation_id"),
    }),
    finalize: createIdempotencyMiddleware(store, "offering.finalize", clock, {
      scope: scopedTo("offering_id"),
    }),
  };
}
