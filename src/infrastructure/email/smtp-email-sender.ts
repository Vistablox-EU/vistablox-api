import nodemailer, { type Transporter } from "nodemailer";

export interface VerificationEmail {
  to: string;
  verificationUrl: string;
}

export interface PasswordResetEmail {
  to: string;
  resetUrl: string;
}

export interface StaffInvitationEmail {
  to: string;
  displayName: string;
  invitationUrl: string;
  expiresAt: Date;
}

export interface ApplicantResponseReminderEmail {
  to: string;
  dueAt: Date;
}

export interface KycRenewalReminderEmail {
  to: string;
  renewalDueAt: Date;
}

export interface ReconfirmationReminderEmail {
  to: string;
  effectiveRightsEndAt: Date;
}

export interface ReconfirmationWindowOpenedEmail {
  to: string;
  effectiveRightsEndAt: Date;
}

export interface EmailSender {
  sendVerificationEmail(email: VerificationEmail): Promise<void>;
  sendPasswordResetEmail(email: PasswordResetEmail): Promise<void>;
  sendStaffInvitationEmail(email: StaffInvitationEmail): Promise<void>;
  sendApplicantResponseReminderEmail(email: ApplicantResponseReminderEmail): Promise<void>;
  sendKycRenewalReminderEmail(email: KycRenewalReminderEmail): Promise<void>;
  sendReconfirmationReminderEmail(email: ReconfirmationReminderEmail): Promise<void>;
  sendReconfirmationWindowOpenedEmail(email: ReconfirmationWindowOpenedEmail): Promise<void>;
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

  public async sendStaffInvitationEmail(email: StaffInvitationEmail): Promise<void> {
    const expiresAt = email.expiresAt.toISOString();
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Your VistaBlox staff invitation",
      text: `Hello ${email.displayName}, accept your VistaBlox staff invitation before ${expiresAt}: ${email.invitationUrl}`,
      html: `<p>Hello ${escapeHtml(email.displayName)},</p><p>Accept your VistaBlox staff invitation before ${escapeHtml(expiresAt)}:</p><p><a href="${escapeHtml(email.invitationUrl)}">Accept invitation</a></p>`,
    });
  }

  public async sendApplicantResponseReminderEmail(
    email: ApplicantResponseReminderEmail,
  ): Promise<void> {
    const dueAt = email.dueAt.toISOString();
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Response needed on your VistaBlox origination case",
      text: `VistaBlox is waiting on your response to an information request. Please respond before ${dueAt}, or the request will expire.`,
      html: `<p>VistaBlox is waiting on your response to an information request.</p><p>Please respond before ${escapeHtml(dueAt)}, or the request will expire.</p>`,
    });
  }

  public async sendKycRenewalReminderEmail(email: KycRenewalReminderEmail): Promise<void> {
    const renewalDueAt = email.renewalDueAt.toISOString();
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Your VistaBlox identity verification needs renewal soon",
      text: `Your VistaBlox identity verification is due for renewal by ${renewalDueAt}. Please sign in to renew it before then.`,
      html: `<p>Your VistaBlox identity verification is due for renewal by ${escapeHtml(renewalDueAt)}.</p><p>Please sign in to renew it before then.</p>`,
    });
  }

  public async sendReconfirmationReminderEmail(email: ReconfirmationReminderEmail): Promise<void> {
    const effectiveRightsEndAt = email.effectiveRightsEndAt.toISOString();
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Action needed: reconfirm your VistaBlox reservation",
      text: `An offering you reserved into has published its final terms. Please sign in to reconfirm your reservation before ${effectiveRightsEndAt}, or it will lapse.`,
      html: `<p>An offering you reserved into has published its final terms.</p><p>Please sign in to reconfirm your reservation before ${escapeHtml(effectiveRightsEndAt)}, or it will lapse.</p>`,
    });
  }

  public async sendReconfirmationWindowOpenedEmail(email: ReconfirmationWindowOpenedEmail): Promise<void> {
    const effectiveRightsEndAt = email.effectiveRightsEndAt.toISOString();
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "VistaBlox has published final terms for your reservation",
      text: `An offering you reserved into has published its final terms and locked disclosure package. Please sign in to review them and reconfirm your reservation before ${effectiveRightsEndAt}, or it will lapse.`,
      html: `<p>An offering you reserved into has published its final terms and locked disclosure package.</p><p>Please sign in to review them and reconfirm your reservation before ${escapeHtml(effectiveRightsEndAt)}, or it will lapse.</p>`,
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
