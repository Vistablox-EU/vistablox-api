import { AppError } from "../../../shared/errors/app-error.js";
import {
  BACKUP_CODE_COUNT,
  generateBackupCodes,
  hashBackupCode,
  normalizeBackupCode,
} from "../domain/totp-policy.js";
import type { TotpProvider } from "../infrastructure/otplib-totp.provider.js";
import type { TotpRepository } from "../repository/totp.repository.js";

export interface EnrolledTotpFactor {
  otpAuthUri: string;
  secret: string;
  backupCodes: string[];
}

// AD-120: enrollment happens the first time fresh-auth needs an MFA factor
// the customer hasn't set up yet, not at registration. Re-enrolling replaces
// the prior secret and backup-code set outright — there is only ever one
// current factor per account.
export class EnrollTotpService {
  public constructor(
    private readonly repository: TotpRepository,
    private readonly provider: TotpProvider,
    private readonly backupCodeHashKey: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string): Promise<EnrolledTotpFactor> {
    const secret = this.provider.generateSecret();
    const accountLabel = await this.repository.getAccountLabel(accountId);
    const otpAuthUri = this.provider.buildOtpAuthUri(secret, accountLabel);
    const backupCodes = generateBackupCodes(BACKUP_CODE_COUNT);

    await this.repository.enroll({
      accountId,
      secret,
      backupCodeHashes: backupCodes.map((code) => hashBackupCode(code, this.backupCodeHashKey)),
      enrolledAt: this.clock(),
    });

    return { otpAuthUri, secret, backupCodes };
  }
}

export interface VerifyTotpResult {
  verified: boolean;
  method: "totp" | "backup_code" | null;
}

export class VerifyTotpService {
  public constructor(
    private readonly repository: TotpRepository,
    private readonly provider: TotpProvider,
    private readonly backupCodeHashKey: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(
    accountId: string,
    code: string,
    providerSessionId?: string,
  ): Promise<VerifyTotpResult> {
    const factor = await this.repository.getFactor(accountId);
    if (factor === null) {
      throw new AppError({
        code: "auth.totp_not_enrolled",
        title: "TOTP not enrolled",
        status: 409,
        detail: "This account has not enrolled a TOTP factor.",
      });
    }

    const now = this.clock();
    if (await this.provider.verify(factor.secret, code)) {
      await this.repository.recordTotpUse(accountId, now);
      if (providerSessionId !== undefined) {
        await this.repository.recordSessionFreshAuth?.({ accountId, providerSessionId, verifiedAt: now });
      }
      return { verified: true, method: "totp" };
    }

    const consumed = await this.repository.consumeBackupCode({
      accountId,
      codeHash: hashBackupCode(normalizeBackupCode(code), this.backupCodeHashKey),
      consumedAt: now,
    });
    if (consumed && providerSessionId !== undefined) {
      await this.repository.recordSessionFreshAuth?.({ accountId, providerSessionId, verifiedAt: now });
    }
    return { verified: consumed, method: consumed ? "backup_code" : null };
  }
}
