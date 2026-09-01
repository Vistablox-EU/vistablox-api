import type {
  DiditStatus,
  KycEligibilityState,
  KycOperationalSubstatus,
  KycPolicyOutcome,
} from "../domain/kyc-policy.js";

export interface KycEligibilityRecord {
  accountId: string;
  diditReference: string | null;
  eligibilityState: KycEligibilityState;
  operationalSubstatus: KycOperationalSubstatus;
  residenceCountryCode: string | null;
  taxResidenceCountryCode: string | null;
  proofOfAddressCurrentUntil: Date | null;
  lastVerifiedAt: Date | null;
  renewalDueAt: Date | null;
}

export interface KycRepository {
  getForAccount(accountId: string): Promise<KycEligibilityRecord | null>;
  findByDiditReference(diditReference: string): Promise<KycEligibilityRecord | null>;
  hasProcessedProviderEvent(eventKey: string): Promise<boolean>;
  reserveSessionStart(input: {
    accountId: string;
    sessionStartId: string;
    residenceCountryCode: string;
    taxResidenceCountryCode: string;
    traceId: string;
    startedAt: Date;
  }): Promise<boolean>;
  completeSessionStart(input: {
    accountId: string;
    sessionStartId: string;
    diditReference: string;
    providerStatus: DiditStatus;
    traceId: string;
    completedAt: Date;
  }): Promise<boolean>;
  failSessionStart(input: {
    accountId: string;
    sessionStartId: string;
    traceId: string;
    failedAt: Date;
  }): Promise<void>;
  applyProviderOutcome(input: {
    eventKey: string;
    eventId: string;
    diditReference: string;
    providerStatus: DiditStatus | null;
    webhookType: string;
    traceId: string;
    providerUpdatedAt: Date;
    outcome: KycPolicyOutcome;
  }): Promise<"applied" | "duplicate" | "stale" | "unmatched">;
  recordUnmatchedProviderEvent(input: {
    eventKey: string;
    eventId: string;
    diditReference: string;
    providerStatus: string;
    webhookType: string;
    traceId: string;
    receivedAt: Date;
    reason: "session_not_found" | "correlation_mismatch" | "configuration_mismatch";
  }): Promise<void>;
}
