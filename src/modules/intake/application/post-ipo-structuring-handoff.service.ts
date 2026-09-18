import { z } from "zod";

import type { PostIpoStructuringHandoffRepository } from "../repository/post-ipo-structuring-handoff.repository.js";

// The job payload shape enqueued by PrismaOfferingRepository.publishFinalOfferingTerms
// (AD-145/AD-152). Parsed defensively here since a pg-boss payload is
// untyped JSON once round-tripped through Postgres.
export const postIpoStructuringHandoffJobSchema = z.object({
  case_id: z.string().trim().min(1),
  trace_id: z.string().trim().min(1),
});

export class TransitionCaseToPostIpoStructuringService {
  public constructor(
    private readonly repository: PostIpoStructuringHandoffRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(payload: unknown): Promise<{ caseId: string; stage: string }> {
    const parsed = postIpoStructuringHandoffJobSchema.parse(payload);
    return this.repository.transitionToPostIpoStructuring({
      caseId: parsed.case_id,
      traceId: parsed.trace_id,
      transitionedAt: this.clock(),
    });
  }
}
