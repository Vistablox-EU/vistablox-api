import { AppError } from "../../../shared/errors/app-error.js";
import type { FinalizeOfferingBody, FinalizeOfferingResponse } from "../api/offering-operations.schemas.js";
import type { FinalizeOfferingRepository } from "../repository/finalize-offering.repository.js";

/**
 * AD-244/AD-245: the founder's "proceed" decision once ipo_value_eur is
 * fully collected — the only path in this codebase that creates
 * settlement.position_ledger rows. Everything eligibility-relevant is
 * re-checked atomically inside the repository call (AD-146 discipline), so
 * this service is orchestration only: map the repository's result to the
 * right HTTP outcome.
 */
export class FinalizeOfferingService {
  public constructor(
    private readonly repository: FinalizeOfferingRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    offeringId: string;
    traceId: string;
    body: FinalizeOfferingBody;
  }): Promise<FinalizeOfferingResponse> {
    const result = await this.repository.finalizeOffering({
      offeringId: input.offeringId,
      accountId: input.accountId,
      founderReviewNotes: input.body.founder_review_notes,
      traceId: input.traceId,
      finalizedAt: this.clock(),
    });

    if (result.conflict === "offering_not_found") {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }
    if (result.conflict === "not_open") {
      throw new AppError({
        code: "offering.finalization_not_available",
        title: "Offering cannot be finalized",
        status: 409,
        detail: "This offering is not currently open for finalization.",
      });
    }
    if (result.conflict === "target_not_reached") {
      throw new AppError({
        code: "offering.finalization_target_not_reached",
        title: "Offering cannot be finalized",
        status: 409,
        detail: "This offering has not yet collected its full target raise (AD-245: no partial-funding path).",
      });
    }

    const finalized = result.finalized;
    if (finalized === null) {
      throw new AppError({
        code: "internal.unexpected",
        title: "Internal server error",
        status: 500,
        detail: "Offering finalization returned neither a result nor a conflict.",
      });
    }

    return {
      data: {
        offering_id: finalized.offeringId,
        status: "final_offering",
        final_offering_published_at: finalized.finalOfferingPublishedAt.toISOString(),
        positions_created: finalized.positionsCreated,
        reservations_cancelled: finalized.reservationsCancelled,
      },
    };
  }
}
