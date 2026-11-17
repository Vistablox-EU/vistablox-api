import type {
  OnrampLateEvidenceReviewRepository,
  OnrampLateEvidenceReviewState,
} from "../repository/onramp-late-evidence.repository.js";
import { toOnrampLateEvidenceEntry } from "./onramp-late-evidence-view.js";

export interface ListOnrampLateEvidenceQuery {
  limit: number;
  after?: string | undefined;
  review_state?: OnrampLateEvidenceReviewState | undefined;
}

/** Staff read of the late onramp funding evidence list (AD-288, issue #168). */
export class ListOnrampLateEvidenceService {
  public constructor(private readonly evidence: OnrampLateEvidenceReviewRepository) {}

  public async execute(query: ListOnrampLateEvidenceQuery) {
    const rows = await this.evidence.listLateEvidence({
      limit: query.limit,
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.review_state === undefined ? {} : { reviewState: query.review_state }),
    });
    const page = rows.slice(0, query.limit);
    return {
      data: page.map(toOnrampLateEvidenceEntry),
      page: { next_cursor: rows.length > query.limit ? (page.at(-1)?.evidenceId ?? null) : null },
    };
  }
}
