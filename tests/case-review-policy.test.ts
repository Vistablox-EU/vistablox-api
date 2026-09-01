import { describe, expect, it } from "vitest";

import {
  addBusinessDays,
  canRecordFounderDecision,
  evaluateInformationRequestPublication,
  isApplicantReminderDue,
  isInformationRequestOverdue,
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

  it("treats a request as overdue only once due_at has passed", () => {
    const dueAt = new Date("2026-09-11T15:30:00.000Z");
    expect(isInformationRequestOverdue({ dueAt, now: new Date("2026-09-11T15:29:59.999Z") })).toBe(
      false,
    );
    expect(isInformationRequestOverdue({ dueAt, now: new Date("2026-09-11T15:30:00.001Z") })).toBe(
      true,
    );
  });

  it("matches the reminder milestone only on its exact elapsed-business-day date", () => {
    const monday = new Date("2026-08-31T09:00:00.000Z");
    const dayThree = addBusinessDays(monday, 3);
    const daySeven = addBusinessDays(monday, 7);
    const dayFive = addBusinessDays(monday, 5);

    expect(
      isApplicantReminderDue({ publishedAt: monday, today: dayThree, reminderBusinessDays: [3, 7] }),
    ).toBe(true);
    expect(
      isApplicantReminderDue({ publishedAt: monday, today: daySeven, reminderBusinessDays: [3, 7] }),
    ).toBe(true);
    expect(
      isApplicantReminderDue({ publishedAt: monday, today: dayFive, reminderBusinessDays: [3, 7] }),
    ).toBe(false);
  });
});
