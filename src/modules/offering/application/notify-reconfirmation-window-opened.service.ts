import { z } from "zod";

import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import type { ReconfirmationWindowOpenedNotificationRepository } from "../repository/reconfirmation-window-opened-notification.repository.js";

// The job payload shape enqueued by PrismaOfferingRepository.publishFinalOfferingTerms
// (case_timers.offering_reconfirmation_window_opened, AD-145/AD-152). Parsed
// defensively here since a pg-boss payload is untyped JSON once round-tripped
// through Postgres — the same pattern openOfferingForApprovedCaseJobSchema
// already uses for the origination handoff.
export const notifyReconfirmationWindowOpenedJobSchema = z.object({
  offering_id: z.string().trim().min(1),
  reservation_ids: z.array(z.string().trim().min(1)).min(1),
  trace_id: z.string().trim().min(1),
});

/**
 * Consumer side of the AD-214/AD-145 window-opened handoff. Re-resolves
 * contact email, effective_rights_end_at, and whether a notification was
 * already sent for each reservation_id in the payload — never trusts a
 * payload snapshot — so a pg-boss retry or duplicate delivery is a safe
 * no-op rather than a duplicate email.
 */
export class NotifyReconfirmationWindowOpenedService {
  public constructor(
    private readonly repository: ReconfirmationWindowOpenedNotificationRepository,
    private readonly emailSender: EmailSender,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(payload: unknown): Promise<JobRunSummary> {
    const parsed = notifyReconfirmationWindowOpenedJobSchema.parse(payload);
    const now = this.clock();
    const reservations = await this.repository.getReservationsForReconfirmationWindowOpenedNotification(
      parsed.reservation_ids,
    );

    let acted = 0;
    for (const reservation of reservations) {
      if (reservation.notificationAlreadySent) continue;
      if (reservation.contactEmail === null) continue;
      await this.emailSender.sendReconfirmationWindowOpenedEmail({
        to: reservation.contactEmail,
        effectiveRightsEndAt: reservation.effectiveRightsEndAt,
      });
      await this.repository.recordReconfirmationWindowOpenedNotificationSent({
        reservationId: reservation.reservationId,
        traceId: parsed.trace_id,
        sentAt: now,
      });
      acted += 1;
    }
    return { checked: reservations.length, acted };
  }
}
