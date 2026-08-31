import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";

import type {
  StaffWebAuthnCeremony,
  VerifiedAuthentication,
  VerifiedRegistration,
} from "../application/staff-webauthn.ceremony.js";

export class SimpleWebAuthnCeremony implements StaffWebAuthnCeremony {
  public constructor(
    private readonly configuration: {
      rpName: string;
      rpId: string;
      expectedOrigin: string;
    },
  ) {}

  public async generateRegistrationOptions(input: Parameters<StaffWebAuthnCeremony["generateRegistrationOptions"]>[0]) {
    return generateRegistrationOptions({
      rpName: this.configuration.rpName,
      rpID: this.configuration.rpId,
      userID: Buffer.from(input.accountId, "utf8"),
      userName: input.accountId,
      userDisplayName: input.accountId,
      attestationType: "none",
      timeout: 5 * 60 * 1000,
      excludeCredentials: input.credentials.map((credential) => ({
        id: credential.credentialId,
        transports: asTransports(credential.transports),
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });
  }

  public async verifyRegistration(
    input: Parameters<StaffWebAuthnCeremony["verifyRegistration"]>[0],
  ): Promise<VerifiedRegistration | null> {
    const result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.configuration.expectedOrigin,
      expectedRPID: this.configuration.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!result.verified) return null;
    return {
      credentialId: result.registrationInfo.credential.id,
      publicKey: result.registrationInfo.credential.publicKey,
      counter: result.registrationInfo.credential.counter,
      deviceType: result.registrationInfo.credentialDeviceType,
      backedUp: result.registrationInfo.credentialBackedUp,
      transports: result.registrationInfo.credential.transports ?? [],
    };
  }

  public async generateAuthenticationOptions(
    credentials: Parameters<StaffWebAuthnCeremony["generateAuthenticationOptions"]>[0],
  ) {
    return generateAuthenticationOptions({
      rpID: this.configuration.rpId,
      timeout: 5 * 60 * 1000,
      userVerification: "required",
      allowCredentials: credentials.map((credential) => ({
        id: credential.credentialId,
        transports: asTransports(credential.transports),
      })),
    });
  }

  public async verifyAuthentication(
    input: Parameters<StaffWebAuthnCeremony["verifyAuthentication"]>[0],
  ): Promise<VerifiedAuthentication | null> {
    const result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.configuration.expectedOrigin,
      expectedRPID: this.configuration.rpId,
      requireUserVerification: true,
      credential: {
        id: input.credential.credentialId,
        publicKey: input.credential.publicKey,
        counter: input.credential.counter,
        transports: asTransports(input.credential.transports),
      },
    });
    if (!result.verified) return null;
    return {
      newCounter: result.authenticationInfo.newCounter,
      deviceType: result.authenticationInfo.credentialDeviceType,
      backedUp: result.authenticationInfo.credentialBackedUp,
    };
  }
}

function asTransports(values: string[]): AuthenticatorTransportFuture[] {
  return values.filter(isTransport);
}

function isTransport(value: string): value is AuthenticatorTransportFuture {
  return ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(
    value,
  );
}
