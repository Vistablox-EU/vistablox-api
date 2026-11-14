export type WebAuthnChallengePurpose = "registration" | "authentication";

export interface StaffWebAuthnCredentialRecord {
  credentialId: string;
  accountId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  transports: string[];
  label: string | null;
}

export interface StaffWebAuthnChallengeRecord {
  challengeId: string;
  accountId: string;
  providerSessionId: string;
  purpose: WebAuthnChallengePurpose;
  challenge: string;
  credentialLabel: string | null;
  expiresAt: Date;
}

export interface StaffWebAuthnRepository {
  listCredentials(accountId: string): Promise<StaffWebAuthnCredentialRecord[]>;
  findCredential(
    accountId: string,
    credentialId: string,
  ): Promise<StaffWebAuthnCredentialRecord | null>;
  isSessionVerified(accountId: string, providerSessionId: string): Promise<boolean>;
  replaceChallenge(input: {
    accountId: string;
    providerSessionId: string;
    purpose: WebAuthnChallengePurpose;
    challenge: string;
    credentialLabel: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<StaffWebAuthnChallengeRecord>;
  getActiveChallenge(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    purpose: WebAuthnChallengePurpose;
    now: Date;
  }): Promise<StaffWebAuthnChallengeRecord | null>;
  failChallenge(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    purpose: WebAuthnChallengePurpose;
    traceId: string;
    reason: "credential_not_found" | "verification_failed";
    failedAt: Date;
  }): Promise<boolean>;
  completeRegistration(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    traceId: string;
    credentialId: string;
    publicKey: Uint8Array<ArrayBuffer>;
    counter: number;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    transports: string[];
    completedAt: Date;
  }): Promise<boolean>;
  completeAuthentication(input: {
    challengeId: string;
    accountId: string;
    providerSessionId: string;
    traceId: string;
    credentialId: string;
    expectedCounter: number;
    newCounter: number;
    deviceType: "singleDevice" | "multiDevice";
    backedUp: boolean;
    completedAt: Date;
  }): Promise<boolean>;
}
