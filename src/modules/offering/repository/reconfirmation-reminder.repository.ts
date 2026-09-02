export interface ReservationAwaitingReconfirmationReminder {
  reservationId: string;
  accountId: string;
  contactEmail: string | null;
  offeringId: string;
  finalOfferingPublishedAt: Date;
  effectiveRightsEndAt: Date;
  lastReminderSentAt: Date | null;
}

export interface RecordReconfirmationReminderSentInput {
  reservationId: string;
  traceId: string;
  sentAt: Date;
}

/**
 * AD-214's reconfirmation-window reminder job, distinct from
 * commitOfferingFinalization (the window-*close* batch). Every reservation
 * still reservation_stage: "awaiting_reconfirmation" is a candidate — the
 * caller (SendReconfirmationRemindersService) decides which ones are
 * actually due via isReconfirmationReminderDue, the same repository-returns-
 * candidates / service-applies-the-clock split listOfferingsPendingFinalizationCommit
 * already uses, so the policy stays independently unit-testable.
 */
export interface ReconfirmationReminderRepository {
  getReconfirmationReminderIntervalHours(): Promise<number>;
  listReservationsAwaitingReconfirmationForReminders(): Promise<ReservationAwaitingReconfirmationReminder[]>;
  recordReconfirmationReminderSent(input: RecordReconfirmationReminderSentInput): Promise<void>;
}
