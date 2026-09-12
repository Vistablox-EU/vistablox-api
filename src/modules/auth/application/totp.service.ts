import { AppError } from "../../../shared/errors/app-error.js";
import type { TotpProvider } from "../infrastructure/otplib-totp.provider.js";
import type { TotpRepository } from "../repository/totp.repository.js";

export interface EnrolledTotpFactor {
  otpAuthUri: string;
  secret: string;
}

// AD-120: enrollment happens the first time fresh-auth needs an MFA factor
// the customer hasn't set up yet, not at registration. Re-enrolling replaces
// the prior secret outright -- there is only ever one current factor per
// account. One-time backup codes were removed at the device-bound auth
// cutover: a code written down is a shared secret with no device binding,
// and it satisfied fresh-auth as strongly as a TOTP code
// (docs/plans/device-bound-auth-backend.md, finding 5b).
export class EnrollTotpService {
  public constructor(
    private readonly repository: TotpRepository,
    private readonly provider: TotpProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string): Promise<EnrolledTotpFactor> {
    const secret = this.provider.generateSecret();
    const accountLabel = await this.repository.getAccountLabel(accountId);
    const otpAuthUri = this.provider.buildOtpAuthUri(secret, accountLabel);

    await this.repository.enroll({ accountId, secret, enrolledAt: this.clock() });

    return { otpAuthUri, secret };
  }
}

export interface VerifyTotpResult {
  verified: boolean;
  method: "totp" | null;
}

export class VerifyTotpService {
  public constructor(
    private readonly repository: TotpRepository,
    private readonly provider: TotpProvider,
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

    if (!(await this.provider.verify(factor.secret, code))) {
      return { verified: false, method: null };
    }

    const now = this.clock();
    await this.repository.recordTotpUse(accountId, now);
    if (providerSessionId !== undefined) {
      await this.repository.recordSessionFreshAuth?.({ accountId, providerSessionId, verifiedAt: now });
    }
    return { verified: true, method: "totp" };
  }
}
