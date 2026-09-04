import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import type { CalculateOperatingDistributionService } from "./calculate-operating-distribution.service.js";
import type { OperatingDistributionRepository } from "../repository/operating-distribution.repository.js";

/**
 * Converts already-recorded rent collections (AD-236's contracted property
 * managers' reports, entered by staff through a process not yet built) into
 * calculated distributions. Never invents a gross-rent figure itself.
 *
 * PLACEHOLDER: management fee, other expenses, and reserve holdback are
 * hardcoded to "0.00" here -- there is no per-PIV fee configuration yet
 * (no real property-management contract terms exist, per AD-236/AD-232).
 * Every distribution this sweep produces is gross rent, undiminished,
 * until that configuration is built. Flagged here rather than silently
 * assumed correct.
 */
export class RunOperatingDistributionSweepService {
  private static readonly PLACEHOLDER_ZERO_EUR = "0.00";

  public constructor(
    private readonly repository: OperatingDistributionRepository,
    private readonly calculateDistribution: CalculateOperatingDistributionService,
  ) {}

  public async execute(): Promise<JobRunSummary> {
    const pending = await this.repository.listRentCollectionsAwaitingDistribution();

    let acted = 0;
    for (const rentCollection of pending) {
      const result = await this.calculateDistribution.execute({
        pivId: rentCollection.pivId,
        periodStart: rentCollection.periodStart,
        periodEnd: rentCollection.periodEnd,
        grossRentCollectedEur: rentCollection.grossRentCollectedEur,
        managementFeeEur: RunOperatingDistributionSweepService.PLACEHOLDER_ZERO_EUR,
        otherExpensesEur: RunOperatingDistributionSweepService.PLACEHOLDER_ZERO_EUR,
        reserveHoldbackEur: RunOperatingDistributionSweepService.PLACEHOLDER_ZERO_EUR,
        // Only ever exercised if this rent collection somehow didn't exist
        // yet -- it always does here, since the repository query only
        // returns collections that are already recorded. Passing the
        // original recorder through (rather than a made-up "system"
        // account) means this stays a valid account_id even in that
        // unreachable branch, instead of a landmine that would violate the
        // FK constraint if the branch were ever somehow hit.
        recordedBy: rentCollection.recordedBy,
      });
      if (!result.alreadyCalculated) acted += 1;
    }

    return { checked: pending.length, acted };
  }
}
