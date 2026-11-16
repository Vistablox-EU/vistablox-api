import { z } from "zod";

import type {
  OnrampWebhookJobQueue,
  ReservationRepository,
} from "../repository/reservation.repository.js";
import type { PollOnrampTransactionsService } from "./poll-onramp-transactions.service.js";

const reservationIdPattern = /^reservation_[A-Za-z0-9_-]{1,120}$/;

/**
 * AD-062's webhook rule: verify, durably receive, acknowledge fast. The router
 * has already checked the signature; this only decides whether the event
 * concerns one of our reservations and enqueues a reconcile job for it.
 */
export class ReceiveCoinbaseOnrampWebhookService {
  public constructor(private readonly queue: OnrampWebhookJobQueue) {}

  public async execute(input: {
    eventType: string;
    partnerUserRef: string | null;
    eventId: string | null;
    traceId: string;
  }): Promise<{ received: true; enqueued: boolean }> {
    if (
      !input.eventType.startsWith("onramp.transaction.") ||
      input.partnerUserRef === null ||
      !reservationIdPattern.test(input.partnerUserRef)
    ) {
      return { received: true, enqueued: false };
    }
    await this.queue.enqueueOnrampWebhookReconcile({
      reservationId: input.partnerUserRef,
      eventId: input.eventId,
      eventType: input.eventType,
      traceId: input.traceId,
    });
    return { received: true, enqueued: true };
  }
}

export const reconcileOnrampWebhookJobSchema = z.object({
  reservationId: z.string().regex(reservationIdPattern),
  eventId: z.string().nullable(),
  eventType: z.string(),
  traceId: z.string(),
});

export type ReconcileOnrampWebhookResult =
  | { status: "ignored"; reservation_id: string }
  | { status: "recorded"; reservation_id: string }
  | { status: "unchanged"; reservation_id: string };

/**
 * The worker side of provider_events.coinbase_onramp_webhook. It runs the
 * poller's own reconcileReservation for the one reservation, so a webhook and
 * a poll resolve, check coverage and record identically, both through
 * recordOnrampMoneyEventOnce (reservation row lock, one event per provider
 * transaction and capital state). A duplicate delivery, or a webhook racing
 * the minute poll, therefore records nothing new. A reservation that already
 * left the pending set (funded, lapsed, unknown) is ignored.
 */
export class ReconcileOnrampWebhookService {
  public constructor(
    private readonly reservations: ReservationRepository,
    private readonly poller: PollOnrampTransactionsService,
  ) {}

  public async execute(payload: unknown): Promise<ReconcileOnrampWebhookResult> {
    const job = reconcileOnrampWebhookJobSchema.parse(payload);
    const reservation = await this.reservations.findPendingPurchaseReservationForTimers(job.reservationId);
    if (reservation === null) return { status: "ignored", reservation_id: job.reservationId };

    // false covers both "CDP still reports the purchase in progress" and
    // "this outcome was already recorded" (a duplicate delivery or the poll
    // got there first); either way nothing new is written.
    const recorded = await this.poller.reconcileReservation(reservation, job.traceId);
    return { status: recorded ? "recorded" : "unchanged", reservation_id: job.reservationId };
  }
}
