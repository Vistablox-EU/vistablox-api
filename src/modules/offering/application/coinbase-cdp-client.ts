export interface CreateOnrampSessionTokenResult {
  token: string;
  channelId: string;
}

export type OnrampTransactionStatus = "created" | "in_progress" | "success" | "failed";

export interface OnrampTransactionSummary {
  transactionId: string;
  status: OnrampTransactionStatus;
  walletAddress: string;
  purchaseCurrency: string;
  purchaseAmountValue: string;
  paymentTotalCurrency: string;
  paymentTotalValue: string;
  txHash: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * Onramp/offramp REST surface only (AD-255). This is a distinct CDP capability
 * from the on-device wallet-tooling use of the CDP SDK (AD-246) — this client
 * never touches signing key material.
 */
export interface CoinbaseCdpClient {
  createOnrampSessionToken(input: {
    walletAddress: string;
    blockchain: string;
  }): Promise<CreateOnrampSessionTokenResult>;

  buildOnrampUrl(input: {
    sessionToken: string;
    partnerUserRef: string;
    redirectUrl: string;
  }): string;

  listBuyTransactions(input: {
    partnerUserRef: string;
    pageKey?: string;
  }): Promise<{ transactions: OnrampTransactionSummary[]; nextPageKey: string | null }>;
}
