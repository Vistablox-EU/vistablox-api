import { describe, expect, it, vi } from "vitest";

import { OpenOfferingForApprovedCaseService } from "../src/modules/offering/application/open-offering-for-approved-case.service.js";
import type { OfferingOriginationHandoffRepository } from "../src/modules/offering/repository/offering-origination-handoff.repository.js";

const now = new Date("2026-09-01T20:00:00.000Z");

describe("OpenOfferingForApprovedCaseService", () => {
  it("parses the job payload and opens the offering", async () => {
    const repository: OfferingOriginationHandoffRepository = {
      openOfferingForApprovedCase: vi
        .fn()
        .mockResolvedValue({ pivId: "piv_01", offeringId: "offering_01" }),
    };
    const service = new OpenOfferingForApprovedCaseService(repository, () => now);

    const result = await service.execute({
      case_id: "case_01",
      property_id: "prop_01",
      ipo_value_eur: "500000.00",
      trace_id: "trace_01",
    });

    expect(result).toEqual({ pivId: "piv_01", offeringId: "offering_01" });
    expect(repository.openOfferingForApprovedCase).toHaveBeenCalledWith({
      caseId: "case_01",
      propertyId: "prop_01",
      ipoValueEur: "500000.00",
      traceId: "trace_01",
      openedAt: now,
    });
  });

  it("rejects a malformed job payload without calling the repository", async () => {
    const repository: OfferingOriginationHandoffRepository = {
      openOfferingForApprovedCase: vi.fn(),
    };
    const service = new OpenOfferingForApprovedCaseService(repository, () => now);

    await expect(service.execute({ case_id: "case_01" })).rejects.toThrow();
    expect(repository.openOfferingForApprovedCase).not.toHaveBeenCalled();
  });
});
