import { describe, expect, it } from "vitest";

import { isReconfirmationReminderDue } from "../src/modules/offering/domain/reconfirmation-reminder.policy.js";

const finalOfferingPublishedAt = new Date("2026-09-02T12:00:00.000Z");
const effectiveRightsEndAt = new Date("2026-09-09T12:00:00.000Z");

describe("isReconfirmationReminderDue", () => {
  it("is not due before the first interval has elapsed since publication", () => {
    expect(
      isReconfirmationReminderDue({
        intervalHours: 48,
        lastReminderSentAt: null,
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        now: new Date("2026-09-04T11:59:59.999Z"),
      }),
    ).toBe(false);
  });

  it("is due once the first interval has elapsed since publication, with no reminder sent yet", () => {
    expect(
      isReconfirmationReminderDue({
        intervalHours: 48,
        lastReminderSentAt: null,
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        now: new Date("2026-09-04T12:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("counts from the last reminder actually sent, not from publication, once one has been sent", () => {
    const lastReminderSentAt = new Date("2026-09-04T12:00:00.000Z");
    expect(
      isReconfirmationReminderDue({
        intervalHours: 48,
        lastReminderSentAt,
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        now: new Date("2026-09-06T11:59:59.999Z"),
      }),
    ).toBe(false);
    expect(
      isReconfirmationReminderDue({
        intervalHours: 48,
        lastReminderSentAt,
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        now: new Date("2026-09-06T12:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("stays due (never silently skipped) when a job tick was missed and a reminder is overdue", () => {
    expect(
      isReconfirmationReminderDue({
        intervalHours: 48,
        lastReminderSentAt: new Date("2026-09-04T12:00:00.000Z"),
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        // Three days late past the next-due instant.
        now: new Date("2026-09-09T11:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("is never due once the window has closed", () => {
    expect(
      isReconfirmationReminderDue({
        intervalHours: 48,
        lastReminderSentAt: null,
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        now: effectiveRightsEndAt,
      }),
    ).toBe(false);
    expect(
      isReconfirmationReminderDue({
        intervalHours: 48,
        lastReminderSentAt: null,
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        now: new Date("2026-09-10T00:00:00.000Z"),
      }),
    ).toBe(false);
  });

  it("is never due for a non-positive interval", () => {
    expect(
      isReconfirmationReminderDue({
        intervalHours: 0,
        lastReminderSentAt: null,
        finalOfferingPublishedAt,
        effectiveRightsEndAt,
        now: new Date("2026-09-05T00:00:00.000Z"),
      }),
    ).toBe(false);
  });
});
