export interface ConsumedAccountRecoveryCode {
  betterAuthUserId: string;
}

export interface AccountRecoveryCodeRepository {
  rotate(input: {
    accountId: string;
    codeHash: string;
    createdAt: Date;
  }): Promise<void>;
  consume(input: {
    accountId: string;
    codeHash: string;
    consumedAt: Date;
  }): Promise<ConsumedAccountRecoveryCode | null>;
}
