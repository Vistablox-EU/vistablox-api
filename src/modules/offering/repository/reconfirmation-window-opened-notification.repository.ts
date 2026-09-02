export interface ReservationForReconfirmationWindowOpenedNotification {
  reservationId: string;
  contactEmail: string | null;
  effectiveRightsEndAt: Date;
  notificationAlreadySent: boolean;
}

export interface RecordReconfirmationWindowOpenedNotificationSentInput {
  reservationId: string;
  traceId: string;
  sentAt: Date;
}

/**
 * AD-214 / PAYMENT_FLOWS.md's Start-event meaning: "final terms are locked,
 * the final package is visible in-app, and investor notification is sent" —
 * the single notification at final_offering_published_at, distinct from and
 * "in addition to — not instead of" (AD-214's own wording) the repeating
 * case_timers.offering_reconfirmation_reminders job. Durably handed off via
 * the AD-145 cross-domain pattern (enqueueTransactionalJob, mirroring
 * case_timers.pre_offering_open_handoff) from inside
 * publishFinalOfferingTerms's own transaction, rather than a synchronous
 * send in the founder's request — so the consumer must re-resolve contact
 * details and be replay-safe (ASYNC_JOBS.md's Idempotency Rule) rather than
 * trusting a payload snapshot. notificationAlreadySent is derived from
 * whether an offering.reconfirmation_window_opened_notification_sent audit
 * row already exists for the reservation, the same audit-log-as-general-
 * event-history approach the reminder job already uses, so a pg-boss retry
 * or duplicate delivery of this job can never double-email an investor.
 */
export interface ReconfirmationWindowOpenedNotificationRepository {
  getReservationsForReconfirmationWindowOpenedNotification(
    reservationIds: string[],
  ): Promise<ReservationForReconfirmationWindowOpenedNotification[]>;
  recordReconfirmationWindowOpenedNotificationSent(
    input: RecordReconfirmationWindowOpenedNotificationSentInput,
  ): Promise<void>;
}
