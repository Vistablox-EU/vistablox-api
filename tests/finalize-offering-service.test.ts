import { describe, expect, it, vi } from "vitest";

import { FinalizeOfferingService } from "../src/modules/offering/application/finalize-offering.service.js";
import type {
  FinalizeOfferingInput,
  FinalizeOfferingRepository,
  FinalizeOfferingResult,
} from "../src/modules/offering/repository/finalize-offering.repository.js";

const now = new Date("2026-09-02T12:00:00.000Z");

function repository(overrides: Partial<FinalizeOfferingRepository> = {}): FinalizeOfferingRepository {
  return {
    finalizeOffering: vi.fn(
      async (input: FinalizeOfferingInput): Promise<FinalizeOfferingResult> => ({
        finalized: {
          offeringId: input.offeringId,
          finalOfferingPublishedAt: input.finalizedAt,
          positionsCreated: 3,
          reservationsCancelled: 1,
        },
        conflict: null,
      }),
    ),
    ...overrides,
  };
}

describe("FinalizeOfferingService", () => {
  it("finalizes an eligible offering and reports the outcome", async () => {
    const finalizeOffering = vi.fn().mockResolvedValue({
      finalized: {
        offeringId: "offering_01",
        finalOfferingPublishedAt: now,
        positionsCreated: 3,
        reservationsCancelled: 1,
      },
      conflict: null,
    });
    const service = new FinalizeOfferingService(repository({ finalizeOffering }), () => now);

    const result = await service.execute({
      accountId: "account_founder",
      offeringId: "offering_01",
      traceId: "req_01",
      body: { founder_review_notes: "IPO value fully collected, proceeding to tokenization." },
    });

    expect(result).toEqual({
      data: {
        offering_id: "offering_01",
        status: "final_offering",
        final_offering_published_at: now.toISOString(),
        positions_created: 3,
        reservations_cancelled: 1,
      },
    });
    expect(finalizeOffering).toHaveBeenCalledWith({
      offeringId: "offering_01",
      accountId: "account_founder",
      founderReviewNotes: "IPO value fully collected, proceeding to tokenization.",
      traceId: "req_01",
      finalizedAt: now,
    });
  });

  it("404s when the offering does not exist", async () => {
    const service = new FinalizeOfferingService(
      repository({ finalizeOffering: vi.fn().mockResolvedValue({ finalized: null, conflict: "offering_not_found" }) }),
      () => now,
    );

    await expect(
      service.execute({
        accountId: "account_founder",
        offeringId: "offering_missing",
        traceId: "req_01",
        body: { founder_review_notes: "notes" },
      }),
    ).rejects.toMatchObject({ code: "offering.not_found", status: 404 });
  });

  it("reports a 409 when the offering is not open for finalization", async () => {
    const service = new FinalizeOfferingService(
      repository({ finalizeOffering: vi.fn().mockResolvedValue({ finalized: null, conflict: "not_open" }) }),
      () => now,
    );

    await expect(
      service.execute({
        accountId: "account_founder",
        offeringId: "offering_01",
        traceId: "req_01",
        body: { founder_review_notes: "notes" },
      }),
    ).rejects.toMatchObject({ code: "offering.finalization_not_available", status: 409 });
  });

  it("reports a 409 when the funding target has not been reached", async () => {
    const service = new FinalizeOfferingService(
      repository({
        finalizeOffering: vi.fn().mockResolvedValue({ finalized: null, conflict: "target_not_reached" }),
      }),
      () => now,
    );

    await expect(
      service.execute({
        accountId: "account_founder",
        offeringId: "offering_01",
        traceId: "req_01",
        body: { founder_review_notes: "notes" },
      }),
    ).rejects.toMatchObject({ code: "offering.finalization_target_not_reached", status: 409 });
  });
});
