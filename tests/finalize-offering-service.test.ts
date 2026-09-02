import { describe, expect, it, vi } from "vitest";

import { FinalizeOfferingService } from "../src/modules/offering/application/finalize-offering.service.js";
import type {
  FinalizeOfferingRepository,
  PublishFinalOfferingTermsInput,
  PublishFinalOfferingTermsResult,
} from "../src/modules/offering/repository/finalize-offering.repository.js";

const now = new Date("2026-09-02T12:00:00.000Z");
const effectiveRightsEndAt = new Date("2026-09-09T12:00:00.000Z");

function repository(overrides: Partial<FinalizeOfferingRepository> = {}): FinalizeOfferingRepository {
  return {
    publishFinalOfferingTerms: vi.fn(
      async (input: PublishFinalOfferingTermsInput): Promise<PublishFinalOfferingTermsResult> => ({
        published: {
          offeringId: input.offeringId,
          finalOfferingPublishedAt: input.publishedAt,
          platformRightsEndAt: effectiveRightsEndAt,
          effectiveRightsEndAt,
          reservationsAwaitingReconfirmation: 3,
          reservationsCancelled: 1,
        },
        conflict: null,
      }),
    ),
    reconfirmReservation: vi.fn(),
    listOfferingsPendingFinalizationCommit: vi.fn().mockResolvedValue([]),
    commitOfferingFinalization: vi.fn(),
    ...overrides,
  };
}

describe("FinalizeOfferingService", () => {
  it("publishes final terms for an eligible offering and reports the outcome", async () => {
    const publishFinalOfferingTerms = vi.fn().mockResolvedValue({
      published: {
        offeringId: "offering_01",
        finalOfferingPublishedAt: now,
        platformRightsEndAt: effectiveRightsEndAt,
        effectiveRightsEndAt,
        reservationsAwaitingReconfirmation: 3,
        reservationsCancelled: 1,
      },
      conflict: null,
    });
    const service = new FinalizeOfferingService(repository({ publishFinalOfferingTerms }), () => now);

    const result = await service.execute({
      accountId: "account_founder",
      offeringId: "offering_01",
      traceId: "req_01",
      body: { founder_review_notes: "IPO value fully collected, proceeding to tokenization." },
    });

    expect(result).toEqual({
      data: {
        offering_id: "offering_01",
        final_offering_published_at: now.toISOString(),
        effective_rights_end_at: effectiveRightsEndAt.toISOString(),
        reservations_awaiting_reconfirmation: 3,
        reservations_cancelled: 1,
      },
    });
    expect(publishFinalOfferingTerms).toHaveBeenCalledWith({
      offeringId: "offering_01",
      accountId: "account_founder",
      founderReviewNotes: "IPO value fully collected, proceeding to tokenization.",
      traceId: "req_01",
      publishedAt: now,
    });
  });

  it("404s when the offering does not exist", async () => {
    const service = new FinalizeOfferingService(
      repository({
        publishFinalOfferingTerms: vi.fn().mockResolvedValue({ published: null, conflict: "offering_not_found" }),
      }),
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
      repository({
        publishFinalOfferingTerms: vi.fn().mockResolvedValue({ published: null, conflict: "not_open" }),
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
    ).rejects.toMatchObject({ code: "offering.finalization_not_available", status: 409 });
  });

  it("reports a 409 when final terms were already published", async () => {
    const service = new FinalizeOfferingService(
      repository({
        publishFinalOfferingTerms: vi.fn().mockResolvedValue({ published: null, conflict: "already_published" }),
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
    ).rejects.toMatchObject({ code: "offering.finalization_not_available", status: 409 });
  });

  it("reports a 409 when the funding target has not been reached", async () => {
    const service = new FinalizeOfferingService(
      repository({
        publishFinalOfferingTerms: vi.fn().mockResolvedValue({ published: null, conflict: "target_not_reached" }),
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
