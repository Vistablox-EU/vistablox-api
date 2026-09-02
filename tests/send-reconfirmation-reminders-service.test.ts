import { describe, expect, it, vi } from "vitest";

import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import { SendReconfirmationRemindersService } from "../src/modules/offering/application/send-reconfirmation-reminders.service.js";
import type {
  ReconfirmationReminderRepository,
  ReservationAwaitingReconfirmationReminder,
} from "../src/modules/offering/repository/reconfirmation-reminder.repository.js";

function reservation(
  overrides: Partial<ReservationAwaitingReconfirmationReminder> = {},
): ReservationAwaitingReconfirmationReminder {
  return {
    reservationId: "reservation_01",
    accountId: "account_01",
    contactEmail: "investor@example.com",
    offeringId: "offering_01",
    finalOfferingPublishedAt: new Date("2026-09-02T12:00:00.000Z"),
    effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
    lastReminderSentAt: null,
    ...overrides,
  };
}

function repository(
  overrides: Partial<ReconfirmationReminderRepository> = {},
): ReconfirmationReminderRepository {
  return {
    getReconfirmationReminderIntervalHours: vi.fn().mockResolvedValue(48),
    listReservationsAwaitingReconfirmationForReminders: vi.fn().mockResolvedValue([]),
    recordReconfirmationReminderSent: vi.fn(),
    ...overrides,
  };
}

function emailSender(overrides: Partial<EmailSender> = {}): EmailSender {
  return {
    sendVerificationEmail: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn(),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    ...overrides,
  };
}

describe("SendReconfirmationRemindersService", () => {
  it("emails a reminder for a reservation whose interval has elapsed and records it as sent", async () => {
    const email = emailSender();
    const recordReconfirmationReminderSent = vi.fn();
    const due = reservation({ lastReminderSentAt: null });
    const service = new SendReconfirmationRemindersService(
      repository({
        listReservationsAwaitingReconfirmationForReminders: vi.fn().mockResolvedValue([due]),
        recordReconfirmationReminderSent,
      }),
      email,
      () => new Date("2026-09-04T12:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(email.sendReconfirmationReminderEmail).toHaveBeenCalledWith({
      to: "investor@example.com",
      effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
    });
    expect(recordReconfirmationReminderSent).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      traceId: "req_trace_01",
      sentAt: new Date("2026-09-04T12:00:00.000Z"),
    });
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("does not act on a reservation whose interval has not elapsed yet", async () => {
    const email = emailSender();
    const service = new SendReconfirmationRemindersService(
      repository({
        listReservationsAwaitingReconfirmationForReminders: vi
          .fn()
          .mockResolvedValue([reservation({ lastReminderSentAt: null })]),
      }),
      email,
      () => new Date("2026-09-03T00:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(email.sendReconfirmationReminderEmail).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("does not act once the window has closed", async () => {
    const email = emailSender();
    const service = new SendReconfirmationRemindersService(
      repository({
        listReservationsAwaitingReconfirmationForReminders: vi.fn().mockResolvedValue([reservation()]),
      }),
      email,
      () => new Date("2026-09-09T12:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(email.sendReconfirmationReminderEmail).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("skips a reservation with no contact email on file, without counting it as acted", async () => {
    const email = emailSender();
    const service = new SendReconfirmationRemindersService(
      repository({
        listReservationsAwaitingReconfirmationForReminders: vi
          .fn()
          .mockResolvedValue([reservation({ contactEmail: null })]),
      }),
      email,
      () => new Date("2026-09-04T12:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(email.sendReconfirmationReminderEmail).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("counts from the last reminder actually sent, not from publication, once one has been sent", async () => {
    const email = emailSender();
    const service = new SendReconfirmationRemindersService(
      repository({
        listReservationsAwaitingReconfirmationForReminders: vi
          .fn()
          .mockResolvedValue([reservation({ lastReminderSentAt: new Date("2026-09-04T12:00:00.000Z") })]),
      }),
      email,
      () => new Date("2026-09-06T00:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(email.sendReconfirmationReminderEmail).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("reports zero when nothing is awaiting reconfirmation", async () => {
    const service = new SendReconfirmationRemindersService(
      repository(),
      emailSender(),
      () => new Date("2026-09-04T12:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(summary).toEqual({ checked: 0, acted: 0 });
  });
});
