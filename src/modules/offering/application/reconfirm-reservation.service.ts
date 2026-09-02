import { AppError } from "../../../shared/errors/app-error.js";
import type { ReconfirmReservationResponse } from "../api/offering.schemas.js";
import type { FinalizeOfferingRepository } from "../repository/finalize-offering.repository.js";

/**
 * PAYMENT_FLOWS.md's "Silence rule": each investor must explicitly
 * reconfirm during the active reconfirmation window opened by
 * FinalizeOfferingService's publish step — no reconfirmation by expiry
 * means the reservation lapses rather than silently finalizing. Ownership,
 * window-open, and disclosure-pack-completeness (AD-037) checks all happen
 * atomically inside the repository call (AD-146 discipline), not just
 * against an advisory read.
 */
export class ReconfirmReservationService {
  public constructor(
    private readonly repository: FinalizeOfferingRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    reservationId: string;
    traceId: string;
  }): Promise<ReconfirmReservationResponse> {
    const result = await this.repository.reconfirmReservation({
      reservationId: input.reservationId,
      accountId: input.accountId,
      traceId: input.traceId,
      reconfirmedAt: this.clock(),
    });

    if (result.conflict === "not_found") {
      throw new AppError({
        code: "offering.reservation_not_found",
        title: "Reservation not found",
        status: 404,
        detail: "The requested reservation does not exist.",
      });
    }
    if (result.conflict === "not_awaiting_reconfirmation") {
      throw new AppError({
        code: "offering.reservation_not_awaiting_reconfirmation",
        title: "Reservation cannot be reconfirmed",
        status: 409,
        detail: "This reservation is not currently awaiting reconfirmation.",
      });
    }
    if (result.conflict === "window_closed") {
      throw new AppError({
        code: "offering.reconfirmation_window_closed",
        title: "Reservation cannot be reconfirmed",
        status: 409,
        detail: "The reconfirmation window for this offering has already closed.",
      });
    }
    if (result.conflict === "disclosure_pack_incomplete") {
      throw new AppError({
        code: "offering.reconfirmation_disclosure_pack_incomplete",
        title: "Reservation cannot be reconfirmed",
        status: 409,
        detail: "The current disclosure pack for this offering is incomplete; reconfirmation is not yet available.",
      });
    }

    const reconfirmedAt = result.reconfirmedAt;
    if (reconfirmedAt === null) {
      throw new AppError({
        code: "internal.unexpected",
        title: "Internal server error",
        status: 500,
        detail: "Reservation reconfirmation returned neither a result nor a conflict.",
      });
    }

    return {
      data: {
        reservation_id: input.reservationId,
        status: "reconfirmed",
        reconfirmed_at: reconfirmedAt.toISOString(),
      },
    };
  }
}
