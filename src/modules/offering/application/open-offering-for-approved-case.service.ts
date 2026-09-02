import { z } from "zod";

import type { OfferingOriginationHandoffRepository } from "../repository/offering-origination-handoff.repository.js";

// The job payload shape enqueued by PrismaOriginationRepository.recordFounderDecision
// (approve branch) via the shared enqueue path (AD-145/AD-152). Parsed
// defensively here since a pg-boss payload is untyped JSON once round-tripped
// through Postgres.
export const openOfferingForApprovedCaseJobSchema = z.object({
  case_id: z.string().trim().min(1),
  property_id: z.string().trim().min(1),
  ipo_value_eur: z.string().trim().min(1),
  trace_id: z.string().trim().min(1),
});

export class OpenOfferingForApprovedCaseService {
  public constructor(
    private readonly repository: OfferingOriginationHandoffRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(payload: unknown): Promise<{ pivId: string; offeringId: string }> {
    const parsed = openOfferingForApprovedCaseJobSchema.parse(payload);
    return this.repository.openOfferingForApprovedCase({
      caseId: parsed.case_id,
      propertyId: parsed.property_id,
      ipoValueEur: parsed.ipo_value_eur,
      traceId: parsed.trace_id,
      openedAt: this.clock(),
    });
  }
}
