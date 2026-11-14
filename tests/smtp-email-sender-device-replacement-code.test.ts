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

describe("SmtpEmailSender.sendDeviceReplacementCodeEmail", () => {
  beforeEach(() => {
    sendMail.mockReset().mockResolvedValue(undefined);
  });

  it("emails the code and its TTL to the bound address, with no link that grants access", async () => {
    await sender().sendDeviceReplacementCodeEmail({
      to: "investor@example.test",
      code: "123456",
      expiresInMinutes: 10,
    });

    const mail = sendMail.mock.calls[0]?.[0] as { to: string; text: string; html: string };
    expect(mail.to).toBe("investor@example.test");
    expect(mail.text).toContain("123456");
    expect(mail.text).toContain("10 minutes");
    // The code is typed back into the app, so the email carries no URL/link.
    expect(mail.text).not.toMatch(/https?:\/\//);
    expect(mail.html).not.toMatch(/<a\s|https?:\/\//);
    expect(mail.html).toContain("123456");
  });
});
