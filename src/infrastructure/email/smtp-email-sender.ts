import nodemailer, { type Transporter } from "nodemailer";

export interface VerificationEmail {
  to: string;
  verificationUrl: string;
}

export interface PasswordResetEmail {
  to: string;
  resetUrl: string;
}

export interface EmailSender {
  sendVerificationEmail(email: VerificationEmail): Promise<void>;
  sendPasswordResetEmail(email: PasswordResetEmail): Promise<void>;
}

export interface SmtpEmailSenderOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  public constructor(private readonly options: SmtpEmailSenderOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      auth: { user: options.user, pass: options.password },
    });
  }

  public async sendVerificationEmail(email: VerificationEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Verify your VistaBlox email address",
      text: `Verify your VistaBlox email address: ${email.verificationUrl}`,
      html: `<p>Verify your VistaBlox email address:</p><p><a href="${escapeHtml(email.verificationUrl)}">Verify email</a></p>`,
    });
  }

  public async sendPasswordResetEmail(email: PasswordResetEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Reset your VistaBlox password",
      text: `Reset your VistaBlox password: ${email.resetUrl}`,
      html: `<p>Reset your VistaBlox password:</p><p><a href="${escapeHtml(email.resetUrl)}">Reset password</a></p>`,
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
