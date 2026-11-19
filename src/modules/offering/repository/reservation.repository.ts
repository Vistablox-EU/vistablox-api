import type { OnrampOutcomeCapitalState } from "../domain/onramp-outcome-recording.policy.js";

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

export type CreateReservationConflict = "offering_not_open" | "settlement_escrow_not_ready" | "capacity_exceeded";

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

/** A reservation as the payment-session route needs it: whose it is, how much, how old, and where it stands. */
export interface ReservationForPaymentSession {
  reservationId: string;
  offeringId: string;
  accountId: string;
  amountEur: string;
  createdAt: Date;
  reservationStage: string;
  /** The latest money_events.capital_state, or null if it has none. */
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

/** A reservation as the webhook job sees it, whatever stage it is in: the recording method, not the lookup, decides what a stage other than 'initiated' means. */
export interface ReservationForOnrampReconciliation {
  reservationId: string;
  accountId: string;
  amountEur: string;
  reservationStage: string;
}

export interface RecordOnrampOutcomeInput {
  reservationId: string;
  provider: string;
  /** The provider transaction id. Together with capitalState it is what an outcome is deduplicated on. */
  providerReference: string;
  capitalState: OnrampOutcomeCapitalState;
  amountEur: string;
  amountEurc: string | null;
  /**
   * When the caller observed the outcome. The stored recorded_at is this time,
   * or one millisecond after the reservation's latest event when that is later
   * (recordedAtAfterLatest): the order the recorders win the row lock in is the
   * order of the history, and readers take the latest event as the state.
   */
  recordedAt: Date;
}

/**
 * What recordOnrampOutcome did, for the poller and the webhook job to act on.
 * Only "recorded" wrote a money event.
 */
export type OnrampOutcomeRecording =
  | { status: "recorded" }
  /**
   * This provider transaction in this state is already recorded for the
   * reservation. `reservationStage` is the stage read under the same lock, so
   * the caller can tell a duplicate on a reservation still 'initiated' from one
   * on a reservation that has moved on (the late-evidence path needs that to
   * know whether the rest of the list is late).
   */
  | { status: "duplicate"; reservationStage: string }
  /** The latest event is a funded state, so nothing more is recorded. */
  | { status: "already_funded" }
  /** The latest event is neither eurc_purchase_pending nor purchase_failed. */
  | { status: "not_awaiting_purchase"; latestCapitalState: string | null }
  /** The reservation left 'initiated' (lapsed, cancelled, or past funding): late evidence, for #195's path. */
  | { status: "other_stage"; reservationStage: string; latestCapitalState: string | null }
  | { status: "unknown_reservation" };

/**
 * The minimised record of one verified Coinbase onramp webhook delivery: ids
 * only, never the body, the signature or a secret (AD-289).
 */
export interface OnrampWebhookReceipt {
  /** The delivery's event id (header), or a digest of the exact body when the header is missing. */
  eventId: string;
  eventType: string;
  transactionId: string | null;
  txHash: string | null;
  /** The reservation id the onramp session was opened with. */
  partnerUserRef: string;
}

/**
 * Writes the receipt and enqueues the provider_events.coinbase_onramp_webhook
 * job in one transaction (enqueueTransactionalJob), so a receipt without its
 * job, or a job without its receipt, cannot exist. A delivery whose event id
 * is already on file writes and enqueues nothing.
 */
export interface OnrampWebhookReceiver {
  receiveOnrampWebhook(receipt: OnrampWebhookReceipt, traceId: string): Promise<"enqueued" | "duplicate">;
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
   * Whether this account already holds a reservation under this client
   * Idempotency-Key on this offering: a plain read, so the service can tell a
   * retry of an existing hold from a new request before it applies the
   * advisory capacity check, which counts the hold against itself.
   * createReservation still decides under the offering lock.
   */
  findReservationByClientKey(input: {
    accountId: string;
    offeringId: string;
    clientIdempotencyKey: string;
  }): Promise<{ reservationId: string } | null>;
  /**
   * The reservation, only when it belongs to this account and offering (null
   * otherwise, whether it does not exist or is somebody else's), with its
   * stage and latest money state.
   */
  findReservationForPaymentSession(input: {
    reservationId: string;
    offeringId: string;
    accountId: string;
  }): Promise<ReservationForPaymentSession | null>;
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
  /** Reservations whose latest money event is eurc_purchase_pending or purchase_failed and that are still 'initiated': the ones a Coinbase transaction-status poll can still move forward. */
  listPendingPurchaseReservationsForTimers(): Promise<PendingPurchaseReservationForTimer[]>;
  /** One reservation in any stage (null only when it does not exist), for the webhook job: a lapsed or cancelled reservation must still reach the recording method's other_stage outcome. */
  findReservationForOnrampReconciliation(reservationId: string): Promise<ReservationForOnrampReconciliation | null>;
  /**
   * The single recording method for onramp outcomes, used by the minute poll
   * and by the webhook job. Under the reservation's FOR UPDATE row lock (the
   * one recordMoneyEvent and expireReservation take, so all three serialise)
   * it reads the stage and the latest money event, and decides by
   * decideOnrampRecording (domain/onramp-outcome-recording.policy.ts): a
   * provider transaction already recorded in the same state is a duplicate; a
   * reservation past 'initiated' is other_stage; a funded latest event is
   * never written over; only a reservation still awaiting its purchase gets a
   * row, stamped so that it is the latest event of the reservation. The
   * returned status says which, and only "recorded" wrote.
   */
  recordOnrampOutcome(input: RecordOnrampOutcomeInput): Promise<OnrampOutcomeRecording>;
}
