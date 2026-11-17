import { AppError } from "../../../shared/errors/app-error.js";
import type { OnrampLateEvidenceReviewRepository } from "../repository/onramp-late-evidence.repository.js";
import { toOnrampLateEvidenceEntry } from "./onramp-late-evidence-view.js";

/**
 * The one thing staff can do to a late onramp evidence entry (AD-288, decided
 * 2026-11-17): say they have looked at it, which is what ends the standing
 * alert for it. Nothing here holds, reinstates or refunds anything, and the
 * entry is not edited otherwise. Idempotent: marking an entry that is already
 * reviewed returns it unchanged, with its first review time and no second
 * audit row. The audit row names the staff account (AD-148).
 */
export class MarkOnrampLateEvidenceReviewedService {
  public constructor(
    private readonly evidence: OnrampLateEvidenceReviewRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: { accountId: string; evidenceId: string; traceId: string }) {
    const result = await this.evidence.markLateEvidenceReviewed({
      evidenceId: input.evidenceId,
      actorAccountId: input.accountId,
      traceId: input.traceId,
      reviewedAt: this.clock(),
    });
    if (result.status === "not_found") {
      throw new AppError({
        code: "offering.onramp_late_evidence_not_found",
        title: "Late onramp evidence not found",
        status: 404,
        detail: "The requested late onramp evidence entry does not exist.",
      });
    }
    return { data: toOnrampLateEvidenceEntry(result.entry) };
  }
}
