import { AppError } from "../../../shared/errors/app-error.js";
import {
  generateAccountRecoveryCode,
  hashAccountRecoveryCode,
} from "../domain/account-recovery-code.js";
import type { AccountRecoveryCodeRepository } from "../repository/account-recovery-code.repository.js";
import type { CustomerAccountAdministrator } from "./customer-account-administrator.js";

export class RotateAccountRecoveryCodeService {
  public constructor(
    private readonly repository: AccountRecoveryCodeRepository,
    private readonly hashKey: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string): Promise<{ code: string; createdAt: Date }> {
    const code = generateAccountRecoveryCode();
    const createdAt = this.clock();
    await this.repository.rotate({
      accountId,
      codeHash: hashAccountRecoveryCode(code, this.hashKey),
      createdAt,
    });
    return { code, createdAt };
  }
}

export class RedeemAccountRecoveryCodeService {
  public constructor(
    private readonly repository: AccountRecoveryCodeRepository,
    private readonly administrator: CustomerAccountAdministrator,
    private readonly hashKey: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    code: string;
  }): Promise<{ passkeyRegistrationContext: string }> {
    const consumed = await this.repository.consume({
      accountId: input.accountId,
      codeHash: hashAccountRecoveryCode(input.code, this.hashKey),
      consumedAt: this.clock(),
    });
    if (consumed === null) {
      throw new AppError({
        code: "authentication.account_recovery_code_invalid",
        title: "Recovery code invalid",
        status: 403,
        detail: "This recovery code is invalid, expired, or has already been used.",
      });
    }

    const passkeyRegistrationContext =
      await this.administrator.prepareSelfServicePasskeyReplacement(
        consumed.betterAuthUserId,
      );
    return { passkeyRegistrationContext };
  }
}
