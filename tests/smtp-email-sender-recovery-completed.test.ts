import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));

vi.mock("nodemailer", () => ({
  default: { createTransport: vi.fn(() => ({ sendMail })) },
}));

import { SmtpEmailSender } from "../src/infrastructure/email/smtp-email-sender.js";

function sender(): SmtpEmailSender {
  return new SmtpEmailSender({
    host: "smtp.example.test",
    port: 587,
    secure: false,
    user: "user",
    password: "test-password",
    from: "VistaBlox <no-reply@example.test>",
  });
}

const cooldownEndsAt = new Date("2026-09-15T12:00:00.000Z");

describe("SmtpEmailSender.sendAccountRecoveryCompletedEmail", () => {
  beforeEach(() => {
    sendMail.mockReset().mockResolvedValue(undefined);
  });

  it("tells a recovered customer to sign in with Google or Apple and set their phone up again, with no link", async () => {
    await sender().sendAccountRecoveryCompletedEmail({
      to: "investor@example.test",
      cooldownEndsAt,
      deviceReenrolmentRequired: true,
    });

    const mail = sendMail.mock.calls[0]?.[0] as { to: string; text: string; html: string };
    expect(mail.to).toBe("investor@example.test");
    expect(mail.text).toContain("sign in with Google or Apple, and set up your phone again");
    expect(mail.text).toContain("signed out and removed");
    expect(mail.text).toContain(cooldownEndsAt.toISOString());
    // Nothing in it grants access: no URL and no link.
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toMatch(/<a\s|https?:\/\//);
  });

  it("keeps the existing wording when no device re-enrolment is needed", async () => {
    await sender().sendAccountRecoveryCompletedEmail({ to: "staff@example.test", cooldownEndsAt });

    const mail = sendMail.mock.calls[0]?.[0] as { text: string };
    expect(mail.text).toBe(
      `Your VistaBlox account recovery is complete. New investments, deposits, and account-control changes stay restricted until ${cooldownEndsAt.toISOString()} as a precaution.`,
    );
  });
});
