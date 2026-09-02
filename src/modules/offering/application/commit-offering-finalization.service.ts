import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { isReconfirmationWindowOpen } from "../domain/finalization.policy.js";
import type { FinalizeOfferingRepository } from "../repository/finalize-offering.repository.js";

/**
 * The window-close half of PAYMENT_FLOWS.md's "Phase-1 Final Offering
 * Settlement Flow" (steps 8-12): once effective_rights_end_at passes, this
 * is a scheduled batch, not a person — it commits settlement.position_ledger
 * rows only for reservations that were actually reconfirmed, and lapses any
 * that stayed unreconfirmed (the "Silence rule").
 */
export class CommitOfferingFinalizationService {
  public constructor(
    private readonly repository: FinalizeOfferingRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const pending = await this.repository.listOfferingsPendingFinalizationCommit();

    let acted = 0;
    for (const offering of pending) {
      if (isReconfirmationWindowOpen({ effectiveRightsEndAt: offering.effectiveRightsEndAt, now })) {
        continue;
      }
      const result = await this.repository.commitOfferingFinalization({
        offeringId: offering.offeringId,
        traceId,
        finalizedAt: now,
      });
      if (result.conflict === null) acted += 1;
    }
    return { checked: pending.length, acted };
  }
}
