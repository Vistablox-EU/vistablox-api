import { describe, expect, it, vi } from "vitest";

import { GetOperationsReadinessService } from "../src/modules/intake/application/get-operations-readiness.service.js";
import type { OperationsReadinessSnapshot } from "../src/modules/intake/repository/intake.repository.js";

const record: OperationsReadinessSnapshot = {
  caseId: "case_01",
  stage: "draft",
  submission: null,
  legalPracticeId: null,
  legalStructuringCompletedAt: null,
  appraisalFirmId: null,
  appraisalCompletedAt: null,
  founder: {
    reviewedByAccountId: null,
    approvedAt: null,
    rejectedAt: null,
    ipoPeriodDays: null,
    ipoValueEur: null,
    ipoEndAt: null,
  },
  offering: null,
};

describe("GetOperationsReadinessService", () => {
  it("uses its clock once and returns a deterministic evaluation time", async () => {
    const clock = vi.fn(() => new Date("2026-09-16T12:00:00.000Z"));
    const service = new GetOperationsReadinessService(
      { getOperationsReadiness: vi.fn().mockResolvedValue(record) },
      clock,
    );
    await expect(service.execute("case_01")).resolves.toMatchObject({
      data: { evaluated_at: "2026-09-16T12:00:00.000Z" },
    });
    expect(clock).toHaveBeenCalledTimes(1);
  });

  it("uses the established case-not-found envelope", async () => {
    const service = new GetOperationsReadinessService({
      getOperationsReadiness: vi.fn().mockResolvedValue(null),
    });
    await expect(service.execute("missing")).rejects.toMatchObject({
      code: "intake.case_not_found",
      status: 404,
    });
  });
});
