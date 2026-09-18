import { describe, expect, it } from "vitest";

import { GetIntakeCaseHistoryService, GetIntakeWorkflowService } from "../src/modules/intake/application/get-intake-workflow.service.js";

const snapshot = {
  caseId: "case_01",
  stage: "submitted",
  createdAt: new Date("2026-09-18T10:00:00.000Z"),
  updatedAt: new Date("2026-09-18T11:00:00.000Z"),
  currentRevisionNumber: 2,
  reviewedByAccountId: null,
  approvedAt: null,
  rejectedAt: null,
  ipoPeriodDays: null,
  ipoEndAt: null,
  ipoValueEur: null,
  rejectionReasonCode: null,
  legalPracticeId: null,
  appraisalFirmId: null,
  legalStructuringCompletedAt: null,
  appraisalCompletedAt: null,
  postIpoStructuringCompletedAt: null,
  offering: null,
  informationRequests: [],
};

describe("intake workflow and history projections", () => {
  it("maps the current stage to the backend-owned workflow catalog and readiness actions", async () => {
    const repository = {
      getIntakeWorkflowSnapshot: async () => snapshot,
      listIntakeCaseHistory: async () => ({ events: [], hasNextPage: false }),
    };
    const service = new GetIntakeWorkflowService(repository, {
      execute: async () => ({
        data: {
          allowed_next_actions: ["request_information"],
          blockers: [],
        },
      }),
    } as never);

    const result = await service.execute("case_01");
    expect(result.data.workflow_type).toBe("operations_review");
    expect(result.data.stage_label).toBe("Operations review");
    expect(result.data.allowed_actions).toEqual(["request_information"]);
    expect(result.data.stage_sequence).toHaveLength(9);
  });

  it("returns a stable empty history page for a known case", async () => {
    const repository = {
      getIntakeWorkflowSnapshot: async () => snapshot,
      listIntakeCaseHistory: async () => ({ events: [], hasNextPage: false }),
    };
    const result = await new GetIntakeCaseHistoryService(repository).execute({ caseId: "case_01", limit: 25 });
    expect(result).toEqual({ data: [], page: { next_cursor: null } });
  });
});
