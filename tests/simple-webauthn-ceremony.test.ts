import { randomBytes } from "node:crypto";

import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vitest";

import type { StaffWebAuthnCredentialRecord } from "../src/modules/auth/repository/staff-webauthn.repository.js";
import { SimpleWebAuthnCeremony } from "../src/modules/auth/infrastructure/simple-webauthn.ceremony.js";
import {
  createSoftwareAuthenticator,
  type SoftwareAuthenticator,
} from "./support/software-authenticator.js";

// The staff step-up ceremony (/internal/v1/auth/webauthn) driven by a real
// software authenticator, so the origin check runs against genuinely signed
// responses: the admin console's origin must pass once it's listed in
// WEBAUTHN_ORIGIN, and anything unlisted must still fail.
const RP_ID = "api.vistablox.io";
const API_ORIGIN = "https://api.vistablox.io";
const ADMIN_ORIGIN = "https://admin.vistablox.io";
const UNLISTED_ORIGIN = "https://evil.vistablox.io";

const ceremony = new SimpleWebAuthnCeremony({
  rpName: "VistaBlox",
  rpId: RP_ID,
  expectedOrigin: [API_ORIGIN, ADMIN_ORIGIN],
});

describe("SimpleWebAuthnCeremony origin allowlist", () => {
  it("verifies a staff passkey registration made on the admin console", async () => {
    const authenticator = createSoftwareAuthenticator(RP_ID);
    const challenge = newChallenge();

    const result = await ceremony.verifyRegistration({
      response: authenticator.register(challenge, ADMIN_ORIGIN),
      expectedChallenge: challenge,
    });

    expect(result?.credentialId).toBe(authenticator.credentialId);
  });

  it("verifies a staff passkey authentication made on the admin console", async () => {
    const authenticator = createSoftwareAuthenticator(RP_ID);
    const challenge = newChallenge();

    const result = await ceremony.verifyAuthentication({
      response: authenticator.authenticate(challenge, ADMIN_ORIGIN),
      expectedChallenge: challenge,
      credential: credentialRecord(authenticator),
    });

    expect(result?.newCounter).toBe(1);
  });

  it("still verifies the rpId's own origin", async () => {
    const authenticator = createSoftwareAuthenticator(RP_ID);
    const challenge = newChallenge();

    const result = await ceremony.verifyAuthentication({
      response: authenticator.authenticate(challenge, API_ORIGIN),
      expectedChallenge: challenge,
      credential: credentialRecord(authenticator),
    });

    expect(result?.newCounter).toBe(1);
  });

  it("rejects a registration from an origin that isn't listed", async () => {
    const authenticator = createSoftwareAuthenticator(RP_ID);
    const challenge = newChallenge();

    await expect(
      ceremony.verifyRegistration({
        response: authenticator.register(challenge, UNLISTED_ORIGIN),
        expectedChallenge: challenge,
      }),
    ).rejects.toThrow("Unexpected registration response origin");
  });

  it("rejects an authentication from an origin that isn't listed", async () => {
    const authenticator = createSoftwareAuthenticator(RP_ID);
    const challenge = newChallenge();

    await expect(
      ceremony.verifyAuthentication({
        response: authenticator.authenticate(challenge, UNLISTED_ORIGIN),
        expectedChallenge: challenge,
        credential: credentialRecord(authenticator),
      }),
    ).rejects.toThrow("Unexpected authentication response origin");
  });

  it("rejects the admin console when only the rpId's own origin is configured", async () => {
    const singleOrigin = new SimpleWebAuthnCeremony({
      rpName: "VistaBlox",
      rpId: RP_ID,
      expectedOrigin: [API_ORIGIN],
    });
    const authenticator = createSoftwareAuthenticator(RP_ID);
    const challenge = newChallenge();

    await expect(
      singleOrigin.verifyAuthentication({
        response: authenticator.authenticate(challenge, ADMIN_ORIGIN),
        expectedChallenge: challenge,
        credential: credentialRecord(authenticator),
      }),
    ).rejects.toThrow("Unexpected authentication response origin");
  });
});

function newChallenge(): string {
  return isoBase64URL.fromBuffer(randomBytes(32));
}

function credentialRecord(authenticator: SoftwareAuthenticator): StaffWebAuthnCredentialRecord {
  return {
    credentialId: authenticator.credentialId,
    accountId: "acct_staff_01",
    publicKey: authenticator.cosePublicKey,
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: ["internal"],
    label: null,
  };
}
