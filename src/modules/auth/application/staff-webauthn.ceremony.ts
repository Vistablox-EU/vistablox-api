import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import type { StaffWebAuthnCredentialRecord } from "../repository/staff-webauthn.repository.js";

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  transports: string[];
}

export interface VerifiedAuthentication {
  newCounter: number;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}

export interface StaffWebAuthnCeremony {
  generateRegistrationOptions(input: {
    accountId: string;
    credentials: StaffWebAuthnCredentialRecord[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(input: {
    response: RegistrationResponseJSON;
    expectedChallenge: string;
  }): Promise<VerifiedRegistration | null>;
  generateAuthenticationOptions(
    credentials: StaffWebAuthnCredentialRecord[],
  ): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(input: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
    credential: StaffWebAuthnCredentialRecord;
  }): Promise<VerifiedAuthentication | null>;
}
