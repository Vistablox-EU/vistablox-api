import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import {
  isApplicantReminderDue,
  isInformationRequestOverdue,
} from "../domain/case-review.policy.js";
import type { OriginationRepository } from "../repository/origination.repository.js";

export class SendApplicantResponseRemindersService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly emailSender: EmailSender,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(): Promise<JobRunSummary> {
    const today = this.clock();
    const [requests, reminderBusinessDays] = await Promise.all([
      this.repository.listPublishedInformationRequestsForTimers(),
      this.repository.getInformationRequestReminderBusinessDays(),
    ]);

    let acted = 0;
    for (const request of requests) {
      if (request.applicantContactEmail === null) continue;
      const due = isApplicantReminderDue({
        publishedAt: request.publishedAt,
        today,
        reminderBusinessDays,
      });
      if (!due) continue;
      await this.emailSender.sendApplicantResponseReminderEmail({
        to: request.applicantContactEmail,
        dueAt: request.dueAt,
      });
      acted += 1;
    }
    return { checked: requests.length, acted };
  }
}

export class ExpireOverdueInformationRequestsService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const requests = await this.repository.listPublishedInformationRequestsForTimers();

    let acted = 0;
    for (const request of requests) {
      if (!isInformationRequestOverdue({ dueAt: request.dueAt, now })) continue;
      const expired = await this.repository.expireInformationRequest({
        requestId: request.requestId,
        caseId: request.caseId,
        traceId,
        expiredAt: now,
      });
      if (expired) acted += 1;
    }
    return { checked: requests.length, acted };
  }
}
