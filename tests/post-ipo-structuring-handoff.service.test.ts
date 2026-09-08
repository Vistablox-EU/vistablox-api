import { describe, expect, it, vi } from "vitest";

import { TransitionCaseToPostIpoStructuringService } from "../src/modules/origination/application/post-ipo-structuring-handoff.service.js";
import type { PostIpoStructuringHandoffRepository } from "../src/modules/origination/repository/post-ipo-structuring-handoff.repository.js";

const now = new Date("2026-09-08T20:00:00.000Z");

describe("TransitionCaseToPostIpoStructuringService", () => {
  it("parses the job payload and transitions the case", async () => {
    const repository: PostIpoStructuringHandoffRepository = {
      transitionToPostIpoStructuring: vi
        .fn()
        .mockResolvedValue({ caseId: "case_01", stage: "post_ipo_structuring" }),
    };
    const service = new TransitionCaseToPostIpoStructuringService(repository, () => now);

    const result = await service.execute({ case_id: "case_01", trace_id: "trace_01" });

    expect(result).toEqual({ caseId: "case_01", stage: "post_ipo_structuring" });
    expect(repository.transitionToPostIpoStructuring).toHaveBeenCalledWith({
      caseId: "case_01",
      traceId: "trace_01",
      transitionedAt: now,
    });
  });

  it("rejects a malformed job payload without calling the repository", async () => {
    const repository: PostIpoStructuringHandoffRepository = {
      transitionToPostIpoStructuring: vi.fn(),
    };
    const service = new TransitionCaseToPostIpoStructuringService(repository, () => now);

    await expect(service.execute({ case_id: "case_01" })).rejects.toThrow();
    expect(repository.transitionToPostIpoStructuring).not.toHaveBeenCalled();
  });
});
