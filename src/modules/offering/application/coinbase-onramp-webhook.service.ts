import type { Logger } from "pino";
import { z } from "zod";

import type { OnrampWebhookReceiver, ReservationRepository } from "../repository/reservation.repository.js";
import type { PollOnrampTransactionsService } from "./poll-onramp-transactions.service.js";

const reservationIdPattern = /^reservation_[A-Za-z0-9_-]{1,120}$/;

/**
 * The fields read from a verified delivery. ASSUMED field names: the design
 * record (COINBASE_ONRAMP.md) names the event types, says `partnerUserRef`
 * correlates a delivery to a reservation and that the payload carries the
 * on-chain `txHash`, but does not spell out the payload's JSON keys, and this
 * code has never seen a real signed delivery (that check belongs to DevOps on
 * staging). `eventType`, `partnerUserRef`, `transactionId` and `txHash` are
 * therefore assumptions, kept in this one place. A delivery whose shape
 * differs is acknowledged and logged, never dropped silently or rejected.
 */
export interface ParsedCoinbaseOnrampEvent {
  eventType: string;
  partnerUserRef: string | null;
  transactionId: string | null;
  txHash: string | null;
}

export type ReceiveCoinbaseOnrampWebhookOutcome = "enqueued" | "duplicate" | "ignored";

/**
 * AD-062's webhook rule: verify, durably receive, acknowledge fast. The router
 * has already checked the signature; this decides whether the event concerns
 * one of our reservations and, if so, records the minimised receipt and
 * enqueues the reconcile job in one transaction (AD-289). Anything verified
 * but not ours is acknowledged without action, so Coinbase is never made to
 * retry what it cannot fix.
 */
export class ReceiveCoinbaseOnrampWebhookService {
  public constructor(
    private readonly receiver: OnrampWebhookReceiver,
    private readonly logger: Logger,
  ) {}

  public async execute(input: {
    eventId: string;
    event: ParsedCoinbaseOnrampEvent | null;
    traceId: string;
  }): Promise<{ received: true; outcome: ReceiveCoinbaseOnrampWebhookOutcome }> {
    const { event } = input;
    if (event === null) return this.ignored(input, null, "unrecognised_payload");
    if (!event.eventType.startsWith("onramp.transaction.")) {
      return this.ignored(input, event.eventType, "not_an_onramp_transaction_event");
    }
    if (event.partnerUserRef === null || !reservationIdPattern.test(event.partnerUserRef)) {
      return this.ignored(input, event.eventType, "no_reservation_reference");
    }

    const result = await this.receiver.receiveOnrampWebhook(
      {
        eventId: input.eventId,
        eventType: event.eventType,
        transactionId: event.transactionId,
        txHash: event.txHash,
        partnerUserRef: event.partnerUserRef,
      },
      input.traceId,
    );
    if (result === "duplicate") {
      this.logger.info(
        { trace_id: input.traceId, event_id: input.eventId, event_type: event.eventType },
        "coinbase onramp webhook already received; nothing enqueued",
      );
    }
    return { received: true, outcome: result };
  }

  private ignored(
    input: { eventId: string; traceId: string },
    eventType: string | null,
    reason: "unrecognised_payload" | "not_an_onramp_transaction_event" | "no_reservation_reference",
  ): { received: true; outcome: "ignored" } {
    // A shape we cannot read is the one case worth a warning: if Coinbase
    // renamed a field, every delivery lands here and the poll alone is
    // carrying funding.
    const log = reason === "unrecognised_payload" ? "warn" : "info";
    this.logger[log](
      { trace_id: input.traceId, event_id: input.eventId, event_type: eventType, reason },
      "coinbase onramp webhook verified but not actionable; acknowledged without action",
    );
    return { received: true, outcome: "ignored" };
  }
}

/**
 * The job the receipt transaction enqueues. `trace_id` is added by
 * enqueueTransactionalJob (AD-152). Only ids: no body, no wallet, no country.
 */
export const reconcileOnrampWebhookJobSchema = z.object({
  reservationId: z.string().regex(reservationIdPattern),
  eventId: z.string(),
  eventType: z.string(),
  trace_id: z.string().default("unknown"),
});

export type ReconcileOnrampWebhookResult =
  | { status: "ignored"; reason: "unknown_reservation"; reservation_id: string; event_id: string }
  | { status: "unresolved"; reservation_id: string; event_id: string }
  | {
      status: "resolved";
      reservation_id: string;
      event_id: string;
      capital_state: "eurc_reserved" | "purchase_failed";
      recording: string;
    };

/**
 * Thrown so pg-boss retries the job: a terminal event (success or failed) for
 * a reservation that has already left 'initiated', while Coinbase's
 * Transaction Status API does not show the transaction yet. For an initiated
 * reservation the minute poll is the backstop, but a lapsed or cancelled one is
 * not in the poll's list, so a retry is the only way this evidence still
 * reaches the recording method's other_stage outcome.
 */
export class OnrampOutcomeNotVisibleError extends Error {
  public constructor(reservationId: string, eventType: string) {
    super(`Coinbase reported ${eventType} for ${reservationId}, but its transaction list does not show the outcome yet.`);
    this.name = "OnrampOutcomeNotVisibleError";
  }
}

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "onramp.transaction.success",
  "onramp.transaction.failed",
]);

/**
 * The worker side of provider_events.coinbase_onramp_webhook (AD-289: webhook
 * first, then an authoritative CDP re-fetch). It looks the reservation up in
 * whatever stage it is in and runs the poller's own reconcileReservation, so a
 * webhook and a poll resolve, check coverage and record identically, through
 * the one recording method. A duplicate delivery, a webhook racing the minute
 * poll, and an outcome already on file therefore write nothing; a reservation
 * that left 'initiated' comes back as other_stage, which reconcileReservation
 * hands to the late-evidence seam. The webhook body is never the source of a
 * status or an amount.
 */
export class ReconcileOnrampWebhookService {
  public constructor(
    private readonly reservations: Pick<ReservationRepository, "findReservationForOnrampReconciliation">,
    private readonly poller: Pick<PollOnrampTransactionsService, "reconcileReservation">,
  ) {}

  public async execute(payload: unknown): Promise<ReconcileOnrampWebhookResult> {
    const job = reconcileOnrampWebhookJobSchema.parse(payload);
    const reservation = await this.reservations.findReservationForOnrampReconciliation(job.reservationId);
    if (reservation === null) {
      return {
        status: "ignored",
        reason: "unknown_reservation",
        reservation_id: job.reservationId,
        event_id: job.eventId,
      };
    }

    const result = await this.poller.reconcileReservation(reservation, job.trace_id);
    if (result.status === "unresolved") {
      if (reservation.reservationStage !== "initiated" && TERMINAL_EVENT_TYPES.has(job.eventType)) {
        throw new OnrampOutcomeNotVisibleError(job.reservationId, job.eventType);
      }
      return { status: "unresolved", reservation_id: job.reservationId, event_id: job.eventId };
    }
    return {
      status: "resolved",
      reservation_id: job.reservationId,
      event_id: job.eventId,
      capital_state: result.capitalState,
      recording: result.recording.status,
    };
  }
}
