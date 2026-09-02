import { describe, expect, it, vi } from "vitest";

import { ClassifyMaterialityService } from "../src/modules/offering/application/classify-materiality.service.js";
import type {
  ClassifyMaterialityInput,
  ClassifyMaterialityResult,
  MaterialityRepository,
} from "../src/modules/offering/repository/materiality.repository.js";

const now = new Date("2026-09-05T12:00:00.000Z");

function repository(overrides: Partial<MaterialityRepository> = {}): MaterialityRepository {
  return {
    classifyMateriality: vi.fn(
      async (input: ClassifyMaterialityInput): Promise<ClassifyMaterialityResult> => ({
        classified: {
          materialityRecordId: "materiality_01",
          offeringId: input.offeringId,
          classification: input.classification,
          thresholdType: input.thresholdType,
          resetTriggered: input.classification !== "non_material",
          classifiedAt: input.classifiedAt,
          effectiveRightsEndAt: input.classification === "non_material" ? null : new Date("2026-09-12T12:00:00.000Z"),
          reservationsReset: input.classification === "non_material" ? 0 : 2,
        },
        conflict: null,
      }),
    ),
    ...overrides,
  };
}

describe("ClassifyMaterialityService", () => {
  it("records a material classification and reports the reset outcome", async () => {
    const classifyMateriality = vi.fn().mockResolvedValue({
      classified: {
        materialityRecordId: "materiality_01",
        offeringId: "offering_01",
        classification: "per_se_material",
        thresholdType: null,
        resetTriggered: true,
        classifiedAt: now,
        effectiveRightsEndAt: new Date("2026-09-12T12:00:00.000Z"),
        reservationsReset: 3,
      },
      conflict: null,
    });
    const service = new ClassifyMaterialityService(repository({ classifyMateriality }), () => now);

    const result = await service.execute({
      accountId: "account_staff",
      offeringId: "offering_01",
      traceId: "req_01",
      body: { change_description: "Change of primary obligor.", classification: "per_se_material", threshold_type: null },
    });

    expect(result).toEqual({
      data: {
        materiality_record_id: "materiality_01",
        offering_id: "offering_01",
        classification: "per_se_material",
        threshold_type: null,
        reset_triggered: true,
        classified_at: now.toISOString(),
        effective_rights_end_at: "2026-09-12T12:00:00.000Z",
        reservations_reset: 3,
      },
    });
    expect(classifyMateriality).toHaveBeenCalledWith({
      offeringId: "offering_01",
      accountId: "account_staff",
      changeDescription: "Change of primary obligor.",
      classification: "per_se_material",
      thresholdType: null,
      traceId: "req_01",
      classifiedAt: now,
    });
  });

  it("records a non_material classification without a reset", async () => {
    const service = new ClassifyMaterialityService(repository(), () => now);

    const result = await service.execute({
      accountId: "account_staff",
      offeringId: "offering_01",
      traceId: "req_01",
      body: { change_description: "Minor typo fixed in the property summary.", classification: "non_material", threshold_type: null },
    });

    expect(result.data.reset_triggered).toBe(false);
    expect(result.data.effective_rights_end_at).toBeNull();
    expect(result.data.reservations_reset).toBe(0);
  });

  it("404s when the offering does not exist", async () => {
    const service = new ClassifyMaterialityService(
      repository({
        classifyMateriality: vi.fn().mockResolvedValue({ classified: null, conflict: "offering_not_found" }),
      }),
      () => now,
    );

    await expect(
      service.execute({
        accountId: "account_staff",
        offeringId: "offering_missing",
        traceId: "req_01",
        body: { change_description: "notes", classification: "non_material", threshold_type: null },
      }),
    ).rejects.toMatchObject({ code: "offering.not_found", status: 404 });
  });

  it("reports a 409 when the offering has no active reconfirmation window", async () => {
    const service = new ClassifyMaterialityService(
      repository({
        classifyMateriality: vi
          .fn()
          .mockResolvedValue({ classified: null, conflict: "no_active_reconfirmation_window" }),
      }),
      () => now,
    );

    await expect(
      service.execute({
        accountId: "account_staff",
        offeringId: "offering_01",
        traceId: "req_01",
        body: { change_description: "notes", classification: "non_material", threshold_type: null },
      }),
    ).rejects.toMatchObject({ code: "offering.materiality_classification_not_available", status: 409 });
  });
});
