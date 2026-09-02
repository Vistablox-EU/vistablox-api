import { describe, expect, it, vi } from "vitest";

import { CommitOfferingFinalizationService } from "../src/modules/offering/application/commit-offering-finalization.service.js";
import type {
  FinalizeOfferingRepository,
  OfferingPendingFinalizationCommit,
} from "../src/modules/offering/repository/finalize-offering.repository.js";

function offering(
  overrides: Partial<OfferingPendingFinalizationCommit> = {},
): OfferingPendingFinalizationCommit {
  return {
    offeringId: "offering_01",
    effectiveRightsEndAt: new Date("2026-09-09T10:00:00.000Z"),
    ...overrides,
  };
}

function repository(overrides: Partial<FinalizeOfferingRepository> = {}): FinalizeOfferingRepository {
  return {
    publishFinalOfferingTerms: vi.fn(),
    reconfirmReservation: vi.fn(),
    listOfferingsPendingFinalizationCommit: vi.fn().mockResolvedValue([]),
    commitOfferingFinalization: vi.fn().mockResolvedValue({
      committed: { offeringId: "offering_01", positionsCreated: 1, reservationsLapsed: 0 },
      conflict: null,
    }),
    ...overrides,
  };
}

describe("CommitOfferingFinalizationService", () => {
  it("commits only offerings whose reconfirmation window has closed", async () => {
    const stillOpen = offering({
      offeringId: "offering_open",
      effectiveRightsEndAt: new Date("2026-09-09T10:00:00.000Z"),
    });
    const closed = offering({
      offeringId: "offering_closed",
      effectiveRightsEndAt: new Date("2026-09-09T09:00:00.000Z"),
    });
    const commitOfferingFinalization = vi.fn().mockResolvedValue({
      committed: { offeringId: "offering_closed", positionsCreated: 2, reservationsLapsed: 1 },
      conflict: null,
    });
    const service = new CommitOfferingFinalizationService(
      repository({
        listOfferingsPendingFinalizationCommit: vi.fn().mockResolvedValue([stillOpen, closed]),
        commitOfferingFinalization,
      }),
      () => new Date("2026-09-09T09:30:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(commitOfferingFinalization).toHaveBeenCalledTimes(1);
    expect(commitOfferingFinalization).toHaveBeenCalledWith({
      offeringId: "offering_closed",
      traceId: "req_trace_01",
      finalizedAt: new Date("2026-09-09T09:30:00.000Z"),
    });
    expect(summary).toEqual({ checked: 2, acted: 1 });
  });

  it("treats exactly the boundary instant as closed", async () => {
    const atBoundary = offering({ effectiveRightsEndAt: new Date("2026-09-09T10:00:00.000Z") });
    const commitOfferingFinalization = vi.fn().mockResolvedValue({
      committed: { offeringId: "offering_01", positionsCreated: 1, reservationsLapsed: 0 },
      conflict: null,
    });
    const service = new CommitOfferingFinalizationService(
      repository({
        listOfferingsPendingFinalizationCommit: vi.fn().mockResolvedValue([atBoundary]),
        commitOfferingFinalization,
      }),
      () => new Date("2026-09-09T10:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(commitOfferingFinalization).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("does not count an offering the repository could not commit due to a concurrent change", async () => {
    const service = new CommitOfferingFinalizationService(
      repository({
        listOfferingsPendingFinalizationCommit: vi.fn().mockResolvedValue([offering()]),
        commitOfferingFinalization: vi.fn().mockResolvedValue({ committed: null, conflict: "window_still_open" }),
      }),
      () => new Date("2026-09-09T10:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("reports zero when nothing is pending commit", async () => {
    const service = new CommitOfferingFinalizationService(repository(), () => new Date("2026-09-09T10:00:00.000Z"));

    const summary = await service.execute("req_trace_01");

    expect(summary).toEqual({ checked: 0, acted: 0 });
  });
});
