import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { isRenewalOverdue, isRenewalReminderDue } from "../domain/kyc-policy.js";
import type { KycRepository } from "../repository/kyc.repository.js";

// AD-213: one scheduled job owns identity.kyc_eligibility.renewal_due_at
// end to end — advance reminders, then the automatic requires_renewal
// transition once the date passes.
export class RunKycRenewalTimerService {
  public constructor(
    private readonly repository: KycRepository,
    private readonly emailSender: EmailSender,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const [accounts, leadDays] = await Promise.all([
      this.repository.listEligibleAccountsForRenewalTimer(),
      this.repository.getRenewalReminderLeadDays(),
    ]);

    let acted = 0;
    for (const account of accounts) {
      if (isRenewalOverdue({ renewalDueAt: account.renewalDueAt, now })) {
        const transitioned = await this.repository.transitionToRequiresRenewal({
          accountId: account.accountId,
          traceId,
          transitionedAt: now,
        });
        if (transitioned) acted += 1;
        continue;
      }
      if (account.contactEmail === null) continue;
      const due = isRenewalReminderDue({
        renewalDueAt: account.renewalDueAt,
        today: now,
        leadDays,
      });
      if (!due) continue;
      await this.emailSender.sendKycRenewalReminderEmail({
        to: account.contactEmail,
        renewalDueAt: account.renewalDueAt,
      });
      acted += 1;
    }
    return { checked: accounts.length, acted };
  }
}
