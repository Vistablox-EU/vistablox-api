import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { isReservationExpired } from "../domain/reservation-eligibility.policy.js";
import type { ReservationRepository } from "../repository/reservation.repository.js";

/**
 * The auto-expiry half of the capacity-hold policy decided alongside
 * AD-255: a reservation holds capacity from the moment it's created, and
 * this releases that hold if it's still unfunded expiryMinutes later.
 * Capacity itself has no separate "release" step to perform beyond this —
 * remaining capacity is computed by summing non-cancelled/non-lapsed
 * reservations at read/check time (AD-146), so flipping reservationStage to
 * 'lapsed' here is the entire release.
 */
export class ExpireUnfundedReservationsService {
  public constructor(
    private readonly repository: ReservationRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly expiryMinutes = 15,
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const reservations = await this.repository.listInitiatedReservationsForTimers();

    let acted = 0;
    for (const reservation of reservations) {
      if (!isReservationExpired({ createdAt: reservation.createdAt, now, expiryMinutes: this.expiryMinutes })) {
        continue;
      }
      const expired = await this.repository.expireReservation({
        reservationId: reservation.reservationId,
        traceId,
        expiredAt: now,
      });
      if (expired) acted += 1;
    }
    return { checked: reservations.length, acted };
  }
}
