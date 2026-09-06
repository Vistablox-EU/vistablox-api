import { describe, expect, it, vi } from "vitest";

import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import { NotifyReconfirmationWindowOpenedService } from "../src/modules/offering/application/notify-reconfirmation-window-opened.service.js";
import type {
  ReconfirmationWindowOpenedNotificationRepository,
  ReservationForReconfirmationWindowOpenedNotification,
} from "../src/modules/offering/repository/reconfirmation-window-opened-notification.repository.js";

const now = new Date("2026-09-02T12:00:00.000Z");

function reservation(
  overrides: Partial<ReservationForReconfirmationWindowOpenedNotification> = {},
): ReservationForReconfirmationWindowOpenedNotification {
  return {
    reservationId: "reservation_01",
    contactEmail: "investor@example.com",
    effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
    notificationAlreadySent: false,
    ...overrides,
  };
}

function repository(
  overrides: Partial<ReconfirmationWindowOpenedNotificationRepository> = {},
): ReconfirmationWindowOpenedNotificationRepository {
  return {
    getReservationsForReconfirmationWindowOpenedNotification: vi.fn().mockResolvedValue([]),
    recordReconfirmationWindowOpenedNotificationSent: vi.fn(),
    ...overrides,
  };
}

function emailSender(overrides: Partial<EmailSender> = {}): EmailSender {
  return {
    sendPasskeyRecoveryEmail: vi.fn(),
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn(),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryCaseOpenedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryApprovedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryRejectedEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountRecoveryCompletedEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("NotifyReconfirmationWindowOpenedService", () => {
  it("parses the job payload, emails a reservation that hasn't been notified yet, and records it as sent", async () => {
    const email = emailSender();
    const recordReconfirmationWindowOpenedNotificationSent = vi.fn();
    const due = reservation({ notificationAlreadySent: false });
    const service = new NotifyReconfirmationWindowOpenedService(
      repository({
        getReservationsForReconfirmationWindowOpenedNotification: vi.fn().mockResolvedValue([due]),
        recordReconfirmationWindowOpenedNotificationSent,
      }),
      email,
      () => now,
    );

    const summary = await service.execute({
      offering_id: "offering_01",
      reservation_ids: ["reservation_01"],
      trace_id: "trace_01",
    });

    expect(email.sendReconfirmationWindowOpenedEmail).toHaveBeenCalledWith({
      to: "investor@example.com",
      effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
    });
    expect(recordReconfirmationWindowOpenedNotificationSent).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      traceId: "trace_01",
      sentAt: now,
    });
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("skips a reservation already notified, without emailing or counting it as acted", async () => {
    const email = emailSender();
    const recordReconfirmationWindowOpenedNotificationSent = vi.fn();
    const service = new NotifyReconfirmationWindowOpenedService(
      repository({
        getReservationsForReconfirmationWindowOpenedNotification: vi
          .fn()
          .mockResolvedValue([reservation({ notificationAlreadySent: true })]),
        recordReconfirmationWindowOpenedNotificationSent,
      }),
      email,
      () => now,
    );

    const summary = await service.execute({
      offering_id: "offering_01",
      reservation_ids: ["reservation_01"],
      trace_id: "trace_01",
    });

    expect(email.sendReconfirmationWindowOpenedEmail).not.toHaveBeenCalled();
    expect(recordReconfirmationWindowOpenedNotificationSent).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("skips a reservation with no contact email on file, without counting it as acted", async () => {
    const email = emailSender();
    const service = new NotifyReconfirmationWindowOpenedService(
      repository({
        getReservationsForReconfirmationWindowOpenedNotification: vi
          .fn()
          .mockResolvedValue([reservation({ contactEmail: null })]),
      }),
      email,
      () => now,
    );

    const summary = await service.execute({
      offering_id: "offering_01",
      reservation_ids: ["reservation_01"],
      trace_id: "trace_01",
    });

    expect(email.sendReconfirmationWindowOpenedEmail).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("acts independently on each reservation in a multi-reservation payload", async () => {
    const email = emailSender();
    const service = new NotifyReconfirmationWindowOpenedService(
      repository({
        getReservationsForReconfirmationWindowOpenedNotification: vi.fn().mockResolvedValue([
          reservation({ reservationId: "reservation_due", notificationAlreadySent: false }),
          reservation({ reservationId: "reservation_already_sent", notificationAlreadySent: true }),
          reservation({ reservationId: "reservation_no_email", contactEmail: null }),
        ]),
      }),
      email,
      () => now,
    );

    const summary = await service.execute({
      offering_id: "offering_01",
      reservation_ids: ["reservation_due", "reservation_already_sent", "reservation_no_email"],
      trace_id: "trace_01",
    });

    expect(email.sendReconfirmationWindowOpenedEmail).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ checked: 3, acted: 1 });
  });

  it("rejects a malformed job payload without calling the repository", async () => {
    const getReservationsForReconfirmationWindowOpenedNotification = vi.fn();
    const service = new NotifyReconfirmationWindowOpenedService(
      repository({ getReservationsForReconfirmationWindowOpenedNotification }),
      emailSender(),
      () => now,
    );

    await expect(service.execute({ offering_id: "offering_01", reservation_ids: [] })).rejects.toThrow();
    expect(getReservationsForReconfirmationWindowOpenedNotification).not.toHaveBeenCalled();
  });
});
