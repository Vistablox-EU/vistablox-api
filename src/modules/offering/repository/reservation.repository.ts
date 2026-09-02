export interface CreateReservationInput {
  reservationId: string;
  offeringId: string;
  accountId: string;
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

export interface CreateReservationResult {
  reservation: CreatedReservation | null;
  conflict: CreateReservationConflict | null;
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

/**
 * The one place that performs AD-146's atomic, transaction-scoped capacity
 * check: createReservation locks the offering row (matching the origination
 * FOR UPDATE pattern in PrismaOriginationRepository.submitInitialCase) and
 * re-verifies both the offering's status and its remaining capacity against
 * fresh data before writing — a passing advisory read
 * (reservation-eligibility.policy.ts) is never treated as sufficient on its
 * own. Returns a conflict result rather than throwing so the service can map
 * each case to the right HTTP status without string-matching an error.
 */
export interface ReservationRepository {
  createReservation(input: CreateReservationInput): Promise<CreateReservationResult>;
  recordMoneyEvent(input: AdvanceReservationCapitalStateInput): Promise<void>;
  /** Mirrors listPublishedInformationRequestsForTimers: an unfiltered list — the domain policy (isReservationExpired), not SQL, decides which of these are actually due. */
  listInitiatedReservationsForTimers(): Promise<InitiatedReservationForTimer[]>;
  /** Idempotent: returns false (no-op) if the reservation is no longer 'initiated' by the time this runs, matching expireInformationRequest's existence/state-check pattern. */
  expireReservation(input: ExpireReservationInput): Promise<boolean>;
  /** Reservations whose latest money event is still eurc_purchase_pending — the ones a Coinbase transaction-status poll can still move forward. */
  listPendingPurchaseReservationsForTimers(): Promise<PendingPurchaseReservationForTimer[]>;
}
