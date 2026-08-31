import { describe, expect, it } from "vitest";

import {
  addBusinessDays,
  canRecordFounderDecision,
  evaluateInformationRequestPublication,
} from "../src/modules/origination/domain/case-review.policy.js";

describe("origination founder-review policy", () => {
  it("allows an information request only for a submitted revision without an active request", () => {
    expect(
      evaluateInformationRequestPublication({
        stage: "submitted",
        hasCurrentRevision: true,
        hasActiveRequest: false,
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects publication from another stage or while a request is active", () => {
    expect(
      evaluateInformationRequestPublication({
        stage: "waiting_on_applicant",
        hasCurrentRevision: true,
        hasActiveRequest: false,
      }),
    ).toMatchObject({ allowed: false, reason: "invalid_stage" });
    expect(
      evaluateInformationRequestPublication({
        stage: "submitted",
        hasCurrentRevision: true,
        hasActiveRequest: true,
      }),
    ).toMatchObject({ allowed: false, reason: "active_request_exists" });
  });

  it("allows a founder decision only on a submitted revision", () => {
    expect(canRecordFounderDecision({ stage: "submitted", hasCurrentRevision: true })).toBe(true);
    expect(canRecordFounderDecision({ stage: "draft", hasCurrentRevision: true })).toBe(false);
    expect(canRecordFounderDecision({ stage: "submitted", hasCurrentRevision: false })).toBe(false);
  });

  it("adds the configured response window using weekdays", () => {
    const friday = new Date("2026-08-28T15:30:00.000Z");
    expect(addBusinessDays(friday, 10).toISOString()).toBe("2026-09-11T15:30:00.000Z");
  });
});
