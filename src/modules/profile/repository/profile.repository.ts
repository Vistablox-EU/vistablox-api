import type { AccountPreferencesSnapshot } from "./account-preferences.repository.js";

export interface ProfileRecord {
  accountId: string;
  accountStatus: "active" | "recovery_review" | "suspended_restricted";
  protectedContactEmail: string | null;
  createdAt: Date;
  loginMethods: Array<{
    methodType: "passkey" | "google" | "apple" | "device_key";
    linkedAt: Date;
  }>;
  kyc: {
    diditReference: string | null;
    providerStatus: string | null;
    eligibilityState: string;
    residenceCountryCode: string | null;
    taxResidenceCountryCode: string | null;
    proofOfAddressStatus: string;
    proofOfAddressCurrentUntil: Date | null;
    lastVerifiedAt: Date | null;
    renewalDueAt: Date | null;
  } | null;
  walletStatus: {
    requestedAt: Date;
    registeredAt: Date | null;
  } | null;
  activitySummary: {
    reservationCount: number;
    activePositionCount: number;
  };
  preferences: AccountPreferencesSnapshot;
  pendingClosureRequest: { reason: string | null; requestedAt: Date } | null;
}

export interface ProfileRepository {
  get(accountId: string): Promise<ProfileRecord | null>;
}
