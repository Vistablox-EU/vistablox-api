export interface TotpFactorRecord {
  accountId: string;
  secret: string;
  enrolledAt: Date;
  lastUsedAt: Date | null;
}

export interface TotpRepository {
  getAccountLabel(accountId: string): Promise<string>;
  getFactor(accountId: string): Promise<TotpFactorRecord | null>;
  enroll(input: {
    accountId: string;
    secret: string;
    backupCodeHashes: string[];
    enrolledAt: Date;
  }): Promise<void>;
  recordTotpUse(accountId: string, usedAt: Date): Promise<void>;
  countUnconsumedBackupCodes(accountId: string): Promise<number>;
  consumeBackupCode(input: {
    accountId: string;
    codeHash: string;
    consumedAt: Date;
  }): Promise<boolean>;
}
