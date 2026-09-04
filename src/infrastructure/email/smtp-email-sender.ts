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

export interface AccountRecoveryCaseOpenedEmail {
  to: string;
}

export interface AccountRecoveryDecisionEmail {
  to: string;
}

export interface AccountRecoveryCompletedEmail {
  to: string;
  cooldownEndsAt: Date;
}

export interface EmailSender {
  sendVerificationEmail(email: VerificationEmail): Promise<void>;
  sendPasswordResetEmail(email: PasswordResetEmail): Promise<void>;
  sendStaffInvitationEmail(email: StaffInvitationEmail): Promise<void>;
  sendApplicantResponseReminderEmail(email: ApplicantResponseReminderEmail): Promise<void>;
  sendKycRenewalReminderEmail(email: KycRenewalReminderEmail): Promise<void>;
  sendReconfirmationReminderEmail(email: ReconfirmationReminderEmail): Promise<void>;
  sendReconfirmationWindowOpenedEmail(email: ReconfirmationWindowOpenedEmail): Promise<void>;
  sendAccountRecoveryCaseOpenedEmail(email: AccountRecoveryCaseOpenedEmail): Promise<void>;
  sendAccountRecoveryApprovedEmail(email: AccountRecoveryDecisionEmail): Promise<void>;
  sendAccountRecoveryRejectedEmail(email: AccountRecoveryDecisionEmail): Promise<void>;
  sendAccountRecoveryCompletedEmail(email: AccountRecoveryCompletedEmail): Promise<void>;
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

  public async sendAccountRecoveryCaseOpenedEmail(email: AccountRecoveryCaseOpenedEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "VistaBlox account recovery case opened",
      text: "A full-lockout account recovery case was opened for your VistaBlox account. Existing sessions were revoked and the account is temporarily restricted while VistaBlox reviews your recovery request. If you did not request this, contact VistaBlox support immediately.",
      html: "<p>A full-lockout account recovery case was opened for your VistaBlox account.</p><p>Existing sessions were revoked and the account is temporarily restricted while VistaBlox reviews your recovery request.</p><p>If you did not request this, contact VistaBlox support immediately.</p>",
    });
  }

  public async sendAccountRecoveryApprovedEmail(email: AccountRecoveryDecisionEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Your VistaBlox account recovery was approved",
      text: "Your full-lockout account recovery case was approved. VistaBlox support will be in touch with next steps to regain access.",
      html: "<p>Your full-lockout account recovery case was approved.</p><p>VistaBlox support will be in touch with next steps to regain access.</p>",
    });
  }

  public async sendAccountRecoveryRejectedEmail(email: AccountRecoveryDecisionEmail): Promise<void> {
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Your VistaBlox account recovery request was not approved",
      text: "Your full-lockout account recovery case was not approved. Contact VistaBlox support if you believe this is in error.",
      html: "<p>Your full-lockout account recovery case was not approved.</p><p>Contact VistaBlox support if you believe this is in error.</p>",
    });
  }

  public async sendAccountRecoveryCompletedEmail(email: AccountRecoveryCompletedEmail): Promise<void> {
    const cooldownEndsAt = email.cooldownEndsAt.toISOString();
    await this.transporter.sendMail({
      from: this.options.from,
      to: email.to,
      subject: "Your VistaBlox account access has been restored",
      text: `Your VistaBlox account recovery is complete. New investments, deposits, and account-control changes stay restricted until ${cooldownEndsAt} as a precaution.`,
      html: `<p>Your VistaBlox account recovery is complete.</p><p>New investments, deposits, and account-control changes stay restricted until ${escapeHtml(cooldownEndsAt)} as a precaution.</p>`,
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
