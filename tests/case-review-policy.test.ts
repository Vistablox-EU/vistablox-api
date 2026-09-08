import { describe, expect, it } from "vitest";

import {
  addBusinessDays,
  canCloseCase,
  canRecordFounderDecision,
  canRecordPartnerWriteback,
  evaluateInformationRequestPublication,
  isApplicantReminderDue,
  isInformationRequestOverdue,
  isPostIpoStructuringComplete,
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

  it("allows withdrawal from every pre-terminal stage the lifecycle diagram shows, and no other", () => {
    for (const stage of ["draft", "submitted", "waiting_on_applicant", "pre_offering_open"]) {
      expect(canCloseCase({ stage, outcome: "withdrawn" })).toBe(true);
    }
    for (const stage of ["post_ipo_structuring", "approved_for_final_offering", "rejected", "withdrawn", "expired"]) {
      expect(canCloseCase({ stage, outcome: "withdrawn" })).toBe(false);
    }
  });

  it("allows a late-stage reject only from pre-offering open, distinct from the submitted-stage initial review", () => {
    expect(canCloseCase({ stage: "pre_offering_open", outcome: "rejected" })).toBe(true);
    expect(canCloseCase({ stage: "submitted", outcome: "rejected" })).toBe(false);
    expect(canCloseCase({ stage: "waiting_on_applicant", outcome: "rejected" })).toBe(false);
    expect(canCloseCase({ stage: "draft", outcome: "rejected" })).toBe(false);
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

  it("allows partner writeback only at post_ipo_structuring, unlike assignment which stays open later", () => {
    expect(canRecordPartnerWriteback({ stage: "post_ipo_structuring" })).toBe(true);
    for (const stage of ["approved_for_final_offering", "pre_offering_open", "submitted", "draft"]) {
      expect(canRecordPartnerWriteback({ stage })).toBe(false);
    }
  });

  it("treats post-IPO structuring as complete only once both workstreams have a completed_at", () => {
    const at = new Date("2026-09-08T12:00:00.000Z");
    expect(
      isPostIpoStructuringComplete({ legalStructuringCompletedAt: at, appraisalCompletedAt: at }),
    ).toBe(true);
    expect(
      isPostIpoStructuringComplete({ legalStructuringCompletedAt: at, appraisalCompletedAt: null }),
    ).toBe(false);
    expect(
      isPostIpoStructuringComplete({ legalStructuringCompletedAt: null, appraisalCompletedAt: at }),
    ).toBe(false);
    expect(
      isPostIpoStructuringComplete({ legalStructuringCompletedAt: null, appraisalCompletedAt: null }),
    ).toBe(false);
  });
});
