import { AppError } from "../../../shared/errors/app-error.js";
import type { FinalizeOfferingBody, FinalizeOfferingResponse } from "../api/offering-operations.schemas.js";
import type { FinalizeOfferingRepository } from "../repository/finalize-offering.repository.js";

/**
 * AD-244/AD-245: the founder's "proceed" decision once ipo_value_eur is
 * fully collected. This only publishes the locked final terms and opens
 * the mandatory 168-hour reconfirmation window (AD-214) — it does not
 * create positions. Each investor must separately reconfirm
 * (ReconfirmReservationService), and only once the window closes does the
 * scheduled commit batch (CommitOfferingFinalizationService) actually
 * create settlement.position_ledger rows. Also requires a complete, current
 * disclosure pack to already exist (PAYMENT_FLOWS.md step 4 bundles
 * publishing that package together with this step) — the same
 * completeness rule ReconfirmReservationService enforces at reconfirmation
 * time, checked here too so the window never opens against a pack no
 * investor could actually act on. See
 * docs/investor-offering.md#1-publishing-final-terms-founder-triggered.
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
    const result = await this.repository.publishFinalOfferingTerms({
      offeringId: input.offeringId,
      accountId: input.accountId,
      founderReviewNotes: input.body.founder_review_notes,
      traceId: input.traceId,
      publishedAt: this.clock(),
    });

    if (result.conflict === "offering_not_found") {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }
    if (result.conflict === "not_open" || result.conflict === "already_published") {
      throw new AppError({
        code: "offering.finalization_not_available",
        title: "Offering cannot be finalized",
        status: 409,
        detail:
          result.conflict === "already_published"
            ? "This offering's final terms have already been published."
            : "This offering is not currently open for finalization.",
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
    if (result.conflict === "disclosure_pack_incomplete") {
      throw new AppError({
        code: "offering.finalization_disclosure_pack_incomplete",
        title: "Offering cannot be finalized",
        status: 409,
        detail:
          "This offering has no complete, current disclosure pack yet — publish one before publishing final terms.",
      });
    }

    const published = result.published;
    if (published === null) {
      throw new AppError({
        code: "internal.unexpected",
        title: "Internal server error",
        status: 500,
        detail: "Publishing final offering terms returned neither a result nor a conflict.",
      });
    }

    return {
      data: {
        offering_id: published.offeringId,
        final_offering_published_at: published.finalOfferingPublishedAt.toISOString(),
        effective_rights_end_at: published.effectiveRightsEndAt.toISOString(),
        reservations_awaiting_reconfirmation: published.reservationsAwaitingReconfirmation,
        reservations_cancelled: published.reservationsCancelled,
      },
    };
  }
}
