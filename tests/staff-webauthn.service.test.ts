import { describe, expect, it, vi } from "vitest";

import type { StaffWebAuthnCeremony } from "../src/modules/auth/application/staff-webauthn.ceremony.js";
import { StaffWebAuthnService } from "../src/modules/auth/application/staff-webauthn.service.js";
import type {
  StaffWebAuthnChallengeRecord,
  StaffWebAuthnCredentialRecord,
  StaffWebAuthnRepository,
} from "../src/modules/auth/repository/staff-webauthn.repository.js";

const now = new Date("2026-08-31T12:00:00.000Z");
const credential: StaffWebAuthnCredentialRecord = {
  credentialId: "credential_01",
  accountId: "acct_staff",
  publicKey: new Uint8Array([1, 2, 3]),
  counter: 7,
  deviceType: "singleDevice",
  backedUp: false,
  transports: ["internal"],
  label: "Laptop",
};
const registrationChallenge: StaffWebAuthnChallengeRecord = {
  challengeId: "wch_registration",
  accountId: "acct_staff",
  providerSessionId: "session_staff",
  purpose: "registration",
  challenge: "registration_challenge",
  credentialLabel: "Laptop",
  expiresAt: new Date("2026-08-31T12:05:00.000Z"),
};
const authenticationChallenge: StaffWebAuthnChallengeRecord = {
  ...registrationChallenge,
  challengeId: "wch_authentication",
  purpose: "authentication",
  challenge: "authentication_challenge",
  credentialLabel: null,
};

function buildService(input?: {
  credentials?: StaffWebAuthnCredentialRecord[];
  sessionVerified?: boolean;
}) {
  const credentials = input?.credentials ?? [];
  const repository: StaffWebAuthnRepository = {
    listCredentials: vi.fn().mockResolvedValue(credentials),
    findCredential: vi.fn().mockResolvedValue(credential),
    isSessionVerified: vi.fn().mockResolvedValue(input?.sessionVerified ?? false),
    replaceChallenge: vi.fn(async (challengeInput) => ({
      ...(challengeInput.purpose === "registration"
        ? registrationChallenge
        : authenticationChallenge),
      challenge: challengeInput.challenge,
      credentialLabel: challengeInput.credentialLabel,
    })),
    getActiveChallenge: vi.fn(async (challengeInput) =>
      challengeInput.purpose === "registration"
        ? registrationChallenge
        : authenticationChallenge,
    ),
    failChallenge: vi.fn().mockResolvedValue(true),
    completeRegistration: vi.fn().mockResolvedValue(true),
    completeAuthentication: vi.fn().mockResolvedValue(true),
  };
  const ceremony = {
    generateRegistrationOptions: vi.fn().mockResolvedValue({
      challenge: "registration_challenge",
    }),
    verifyRegistration: vi.fn().mockResolvedValue({
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      transports: credential.transports,
    }),
    generateAuthenticationOptions: vi.fn().mockResolvedValue({
      challenge: "authentication_challenge",
    }),
    verifyAuthentication: vi.fn().mockResolvedValue({
      newCounter: 8,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
    }),
  } as unknown as StaffWebAuthnCeremony;

  return {
    service: new StaffWebAuthnService(repository, ceremony, () => now),
    repository,
    ceremony,
  };
}

describe("staff WebAuthn service", () => {
  it("allows first-credential registration to bootstrap a staff account", async () => {
    const { service, repository } = buildService();

    const result = await service.startRegistration({
      accountId: "acct_staff",
      providerSessionId: "session_staff",
      credentialLabel: "Laptop",
    });

    expect(result.data.challenge_id).toBe("wch_registration");
    expect(repository.replaceChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "registration",
        challenge: "registration_challenge",
        expiresAt: new Date("2026-08-31T12:05:00.000Z"),
      }),
    );
  });

  it("requires current-session MFA before adding a second credential", async () => {
    const { service, ceremony } = buildService({ credentials: [credential] });

    await expect(
      service.startRegistration({
        accountId: "acct_staff",
        providerSessionId: "session_staff",
        credentialLabel: "Backup key",
      }),
    ).rejects.toMatchObject({ code: "authentication.staff_mfa_required", status: 403 });
    expect(ceremony.generateRegistrationOptions).not.toHaveBeenCalled();
  });

  it("registers the verified credential and marks the session MFA-verified", async () => {
    const { service, repository } = buildService();

    const result = await service.finishRegistration({
      accountId: "acct_staff",
      providerSessionId: "session_staff",
      traceId: "trace_registration",
      challengeId: "wch_registration",
      response: { id: credential.credentialId } as never,
    });

    expect(result.data).toEqual({
      verified: true,
      credential_id: "credential_01",
      staff_mfa_verified: true,
    });
    expect(repository.completeRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: "wch_registration",
        credentialId: "credential_01",
        traceId: "trace_registration",
      }),
    );
  });

  it("requires enrollment before starting authentication", async () => {
    const { service } = buildService();

    await expect(
      service.startAuthentication({
        accountId: "acct_staff",
        providerSessionId: "session_staff",
      }),
    ).rejects.toMatchObject({
      code: "authentication.staff_webauthn_enrollment_required",
      status: 409,
    });
  });

  it("verifies an assertion, advances its counter, and marks this session", async () => {
    const { service, repository } = buildService({ credentials: [credential] });

    const result = await service.finishAuthentication({
      accountId: "acct_staff",
      providerSessionId: "session_staff",
      traceId: "trace_authentication",
      challengeId: "wch_authentication",
      response: { id: credential.credentialId } as never,
    });

    expect(result.data.staff_mfa_verified).toBe(true);
    expect(repository.completeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: "credential_01",
        expectedCounter: 7,
        newCounter: 8,
      }),
    );
  });

  it("consumes and audits an authentication challenge after failed verification", async () => {
    const { service, repository, ceremony } = buildService({ credentials: [credential] });
    vi.mocked(ceremony.verifyAuthentication).mockRejectedValueOnce(
      new Error("invalid signature"),
    );

    await expect(
      service.finishAuthentication({
        accountId: "acct_staff",
        providerSessionId: "session_staff",
        traceId: "trace_failed_authentication",
        challengeId: "wch_authentication",
        response: { id: credential.credentialId } as never,
      }),
    ).rejects.toMatchObject({
      code: "authentication.webauthn_verification_failed",
      status: 401,
    });
    expect(repository.failChallenge).toHaveBeenCalledWith({
      challengeId: "wch_authentication",
      accountId: "acct_staff",
      providerSessionId: "session_staff",
      purpose: "authentication",
      traceId: "trace_failed_authentication",
      reason: "verification_failed",
      failedAt: now,
    });
    expect(repository.completeAuthentication).not.toHaveBeenCalled();
  });
});
