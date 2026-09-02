import { describe, expect, it, vi } from "vitest";

import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import { RunKycRenewalTimerService } from "../src/modules/identity/application/kyc-renewal.service.js";
import type { KycRepository } from "../src/modules/identity/repository/kyc.repository.js";

function repository(overrides: Partial<KycRepository> = {}): KycRepository {
  return {
    getForAccount: vi.fn(),
    findByDiditReference: vi.fn(),
    findByProofOfAddressDiditReference: vi.fn(),
    hasProcessedProviderEvent: vi.fn(),
    reserveSessionStart: vi.fn(),
    completeSessionStart: vi.fn(),
    failSessionStart: vi.fn(),
    reserveProofOfAddressSessionStart: vi.fn(),
    completeProofOfAddressSessionStart: vi.fn(),
    failProofOfAddressSessionStart: vi.fn(),
    applyProviderOutcome: vi.fn(),
    applyProofOfAddressOutcome: vi.fn(),
    recordUnmatchedProviderEvent: vi.fn(),
    getRenewalReminderLeadDays: vi.fn().mockResolvedValue(30),
    listEligibleAccountsForRenewalTimer: vi.fn().mockResolvedValue([]),
    transitionToRequiresRenewal: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function emailSender(overrides: Partial<EmailSender> = {}): EmailSender {
  return {
    sendVerificationEmail: vi.fn(),
    sendPasswordResetEmail: vi.fn(),
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn(),
    sendKycRenewalReminderEmail: vi.fn().mockResolvedValue(undefined),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    ...overrides,
  };
}

describe("RunKycRenewalTimerService", () => {
  it("transitions an overdue account instead of sending it a reminder", async () => {
    const email = emailSender();
    const transitionToRequiresRenewal = vi.fn().mockResolvedValue(true);
    const service = new RunKycRenewalTimerService(
      repository({
        listEligibleAccountsForRenewalTimer: vi.fn().mockResolvedValue([
          {
            accountId: "acct_overdue",
            contactEmail: "overdue@example.com",
            renewalDueAt: new Date("2028-09-01T00:00:00.000Z"),
          },
        ]),
        transitionToRequiresRenewal,
      }),
      email,
      () => new Date("2028-09-03T00:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(transitionToRequiresRenewal).toHaveBeenCalledWith({
      accountId: "acct_overdue",
      traceId: "req_trace_01",
      transitionedAt: new Date("2028-09-03T00:00:00.000Z"),
    });
    expect(email.sendKycRenewalReminderEmail).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("emails a reminder for an account on its lead-time date, without transitioning it", async () => {
    const email = emailSender();
    const transitionToRequiresRenewal = vi.fn();
    const service = new RunKycRenewalTimerService(
      repository({
        listEligibleAccountsForRenewalTimer: vi.fn().mockResolvedValue([
          {
            accountId: "acct_due_soon",
            contactEmail: "due-soon@example.com",
            renewalDueAt: new Date("2028-09-01T00:00:00.000Z"),
          },
        ]),
        getRenewalReminderLeadDays: vi.fn().mockResolvedValue(30),
        transitionToRequiresRenewal,
      }),
      email,
      () => new Date("2028-08-02T00:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(email.sendKycRenewalReminderEmail).toHaveBeenCalledWith({
      to: "due-soon@example.com",
      renewalDueAt: new Date("2028-09-01T00:00:00.000Z"),
    });
    expect(transitionToRequiresRenewal).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });

  it("does not act on an account that is neither overdue nor on its reminder date", async () => {
    const email = emailSender();
    const transitionToRequiresRenewal = vi.fn();
    const service = new RunKycRenewalTimerService(
      repository({
        listEligibleAccountsForRenewalTimer: vi.fn().mockResolvedValue([
          {
            accountId: "acct_not_due",
            contactEmail: "not-due@example.com",
            renewalDueAt: new Date("2028-09-01T00:00:00.000Z"),
          },
        ]),
        transitionToRequiresRenewal,
      }),
      email,
      () => new Date("2028-06-01T00:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(email.sendKycRenewalReminderEmail).not.toHaveBeenCalled();
    expect(transitionToRequiresRenewal).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });
});
