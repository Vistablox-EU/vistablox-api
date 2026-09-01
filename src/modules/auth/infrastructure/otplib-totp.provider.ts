import { OTP } from "otplib";

export interface TotpProvider {
  generateSecret(): string;
  verify(secret: string, token: string): Promise<boolean>;
  buildOtpAuthUri(secret: string, accountLabel: string): string;
}

export class OtplibTotpProvider implements TotpProvider {
  private readonly otp = new OTP({ strategy: "totp" });

  public generateSecret(): string {
    return this.otp.generateSecret();
  }

  public async verify(secret: string, token: string): Promise<boolean> {
    const result = await this.otp.verify({ secret, token, epochTolerance: [1, 1] });
    return result.valid;
  }

  public buildOtpAuthUri(secret: string, accountLabel: string): string {
    return this.otp.generateURI({ issuer: "VistaBlox", label: accountLabel, secret });
  }
}
