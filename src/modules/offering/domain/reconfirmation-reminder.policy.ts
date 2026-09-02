/**
 * AD-214 / PAYMENT_FLOWS.md's Reminder cadence rule: reminders repeat at a
 * platform.settings-configurable interval throughout the open window, not
 * just once at final_offering_published_at. Unlike the KYC renewal
 * reminder (which counts back a fixed lead time from a known due date),
 * there's no single target date to count back from here — reminders repeat
 * indefinitely until the window closes — so due-ness is derived from time
 * elapsed since the last reminder actually sent (or since the window
 * opened, if none has been sent yet), not from a calendar-date match. That
 * makes this robust to a missed or delayed job tick: an overdue reminder
 * stays due until it's actually sent, rather than being silently skipped.
 */
export function isReconfirmationReminderDue(input: {
  intervalHours: number;
  lastReminderSentAt: Date | null;
  finalOfferingPublishedAt: Date;
  effectiveRightsEndAt: Date;
  now: Date;
}): boolean {
  if (input.now.getTime() >= input.effectiveRightsEndAt.getTime()) return false;
  if (input.intervalHours <= 0) return false;
  const since = input.lastReminderSentAt ?? input.finalOfferingPublishedAt;
  const dueAt = since.getTime() + input.intervalHours * 60 * 60 * 1000;
  return input.now.getTime() >= dueAt;
}
