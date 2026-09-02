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
}
