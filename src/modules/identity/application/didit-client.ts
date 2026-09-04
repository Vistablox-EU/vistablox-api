import type { DiditDecisionSummary, DiditStatus } from "../domain/kyc-policy.js";

export interface DiditClient {
  createSession(input: {
    workflowId: string;
    accountId: string;
    callbackUrl: string;
    sessionStartId: string;
    purpose: "baseline_kyc" | "owner_proof_of_address" | "account_recovery";
    language?: string;
  }): Promise<{
    sessionId: string;
    verificationUrl: string;
    status: DiditStatus;
    workflowId: string;
    vendorData: string;
  }>;
  getDecision(sessionId: string): Promise<DiditDecisionSummary>;
}
