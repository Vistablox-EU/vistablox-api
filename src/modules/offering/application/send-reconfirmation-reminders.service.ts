import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { isReconfirmationReminderDue } from "../domain/reconfirmation-reminder.policy.js";
import type { ReconfirmationReminderRepository } from "../repository/reconfirmation-reminder.repository.js";

/**
 * AD-214's reconfirmation-window reminder job — distinct from
 * CommitOfferingFinalizationService, which only fires once at window
 * close. PAYMENT_FLOWS.md: "not just the single notification at
 * final_offering_published_at" — repeats at a platform.settings-
 * configurable interval throughout the open window, the same
 * stakes-asymmetry AD-213 already applied to KYC renewal reminders.
 */
export class SendReconfirmationRemindersService {
  public constructor(
    private readonly repository: ReconfirmationReminderRepository,
    private readonly emailSender: EmailSender,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const [reservations, intervalHours] = await Promise.all([
      this.repository.listReservationsAwaitingReconfirmationForReminders(),
      this.repository.getReconfirmationReminderIntervalHours(),
    ]);

    let acted = 0;
    for (const reservation of reservations) {
      const due = isReconfirmationReminderDue({
        intervalHours,
        lastReminderSentAt: reservation.lastReminderSentAt,
        finalOfferingPublishedAt: reservation.finalOfferingPublishedAt,
        effectiveRightsEndAt: reservation.effectiveRightsEndAt,
        now,
      });
      if (!due) continue;
      if (reservation.contactEmail === null) continue;
      await this.emailSender.sendReconfirmationReminderEmail({
        to: reservation.contactEmail,
        effectiveRightsEndAt: reservation.effectiveRightsEndAt,
      });
      await this.repository.recordReconfirmationReminderSent({
        reservationId: reservation.reservationId,
        traceId,
        sentAt: now,
      });
      acted += 1;
    }
    return { checked: reservations.length, acted };
  }
}
