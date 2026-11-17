export interface CreateReservationInput {
  reservationId: string;
  offeringId: string;
  accountId: string;
  clientIdempotencyKey?: string | null;
  amountEur: string;
  disclosurePackVersionAtReservation: string | null;
  traceId: string;
  createdAt: Date;
}

export interface CreatedReservation {
  reservationId: string;
  createdAt: Date;
}

export type CreateReservationConflict = "offering_not_open" | "capacity_exceeded";

/**
 * What a client-idempotency-key hit found: the stored reservation's amount,
 * lifecycle stage and latest money state, read in the same transaction (under
 * the same offering lock) as the lookup. The caller needs it to decide whether
 * a retry may be served at all -- a key hit on a reservation that has since
 * been funded, lapsed, or was created for a different amount must not be
 * treated like a fresh, still-payable one.
 */
export interface ReusedReservationState {
  amountEur: string;
  reservationStage: string;
  latestCapitalState: string | null;
}

export interface CreateReservationResult {
  reservation: CreatedReservation | null;
  conflict: CreateReservationConflict | null;
  reused?: boolean;
  /** Present exactly when `reused` is true. */
  replay?: ReusedReservationState;
}

export interface AdvanceReservationCapitalStateInput {
  reservationId: string;
  provider: string;
  providerReference: string | null;
  capitalState: string;
  amountEur: string;
  amountEurc: string | null;
  recordedAt: Date;
}

export interface InitiatedReservationForTimer {
  reservationId: string;
  offeringId: string;
  accountId: string;
  createdAt: Date;
  /** The reservation's latest money_events.capital_state, or null if it somehow has none yet. FUNDED_CAPITAL_STATES-listed values must never be auto-expired even past the 15-minute window. */
  latestCapitalState: string | null;
}

export interface ExpireReservationInput {
  reservationId: string;
  traceId: string;
  expiredAt: Date;
}

export interface PendingPurchaseReservationForTimer {
  reservationId: string;
  accountId: string;
  amountEur: string;
}

export interface OnrampWebhookReconcileJob {
  reservationId: string;
  eventId: string | null;
  eventType: string;
  traceId: string;
}

/** Durable receipt for a verified Coinbase onramp webhook: a plain pg-boss send (provider_events.coinbase_onramp_webhook), like enqueueDiditWebhookProcessing. */
export interface OnrampWebhookJobQueue {
  enqueueOnrampWebhookReconcile(job: OnrampWebhookReconcileJob): Promise<void>;
}

/**
 * The one place that performs AD-146's atomic, transaction-scoped capacity
 * check: createReservation locks the offering row (matching the intake
 * FOR UPDATE pattern in PrismaIntakeRepository.submitInitialCase) and
 * re-verifies both the offering's status and its remaining capacity against
 * fresh data before writing — a passing advisory read
 * (reservation-eligibility.policy.ts) is never treated as sufficient on its
 * own. Returns a conflict result rather than throwing so the service can map
 * each case to the right HTTP status without string-matching an error.
 */
export interface ReservationRepository {
  createReservation(input: CreateReservationInput): Promise<CreateReservationResult>;
  /**
   * Records a money event under the reservation's row lock, the same lock
   * expireReservation takes, so the two serialise. Returns false (writes
   * nothing) when the reservation is no longer 'initiated', or when the event
   * would put an unfunded state over funded money.
   */
  recordMoneyEvent(input: AdvanceReservationCapitalStateInput): Promise<boolean>;
  /** Mirrors listPublishedInformationRequestsForTimers: an unfiltered list — the domain policy (isReservationExpired), not SQL, decides which of these are actually due. */
  listInitiatedReservationsForTimers(): Promise<InitiatedReservationForTimer[]>;
  /** Idempotent: returns false (no-op) if the reservation is no longer 'initiated' by the time this runs, matching expireInformationRequest's existence/state-check pattern. */
  expireReservation(input: ExpireReservationInput): Promise<boolean>;
  /** Reservations whose latest money event is still eurc_purchase_pending — the ones a Coinbase transaction-status poll can still move forward. */
  listPendingPurchaseReservationsForTimers(): Promise<PendingPurchaseReservationForTimer[]>;
  /** The same filter as listPendingPurchaseReservationsForTimers, for one reservation: null once it has left the pending set (funded, lapsed, or unknown). */
  findPendingPurchaseReservationForTimers(reservationId: string): Promise<PendingPurchaseReservationForTimer | null>;
  /**
   * The single recording path for onramp outcomes, shared by the minute poll
   * and the webhook-triggered reconcile. Under the reservation's FOR UPDATE
   * row lock (the same lock expireReservation takes) it records only while
   * the reservation is still 'initiated' with an eurc_purchase_pending /
   * purchase_failed latest state, and skips when the latest event already
   * carries this providerReference + capitalState. Returns whether a row was
   * written, so concurrent or repeated deliveries record one money event.
   */
  recordOnrampMoneyEventOnce(input: AdvanceReservationCapitalStateInput): Promise<boolean>;
}
