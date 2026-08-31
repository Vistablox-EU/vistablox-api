import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

import { AppError } from "../../../shared/errors/app-error.js";
import type { StaffWebAuthnRepository } from "../repository/staff-webauthn.repository.js";
import type { StaffWebAuthnCeremony } from "./staff-webauthn.ceremony.js";

const challengeLifetimeMs = 5 * 60 * 1000;

export class StaffWebAuthnService {
  public constructor(
    private readonly repository: StaffWebAuthnRepository,
    private readonly ceremony: StaffWebAuthnCeremony,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async startRegistration(input: {
    accountId: string;
    providerSessionId: string;
    credentialLabel: string | null;
  }) {
    const credentials = await this.repository.listCredentials(input.accountId);
    await this.requireVerifiedSessionForAdditionalCredential(input, credentials.length);

    const options = await this.ceremony.generateRegistrationOptions({
      accountId: input.accountId,
      credentials,
    });
    const createdAt = this.clock();
    const challenge = await this.repository.replaceChallenge({
      accountId: input.accountId,
      providerSessionId: input.providerSessionId,
      purpose: "registration",
      challenge: options.challenge,
      credentialLabel: input.credentialLabel,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + challengeLifetimeMs),
    });
    return { data: { challenge_id: challenge.challengeId, public_key: options } };
  }

  public async finishRegistration(input: {
    accountId: string;
    providerSessionId: string;
    traceId: string;
    challengeId: string;
    response: RegistrationResponseJSON;
  }) {
    const now = this.clock();
    const [challenge, credentials] = await Promise.all([
      this.repository.getActiveChallenge({
        challengeId: input.challengeId,
        accountId: input.accountId,
        providerSessionId: input.providerSessionId,
        purpose: "registration",
        now,
      }),
      this.repository.listCredentials(input.accountId),
    ]);
    if (challenge === null) throw invalidChallengeError();
    await this.requireVerifiedSessionForAdditionalCredential(input, credentials.length);

    const verified = await safelyVerify(() =>
      this.ceremony.verifyRegistration({
        response: input.response,
        expectedChallenge: challenge.challenge,
      }),
    );
    if (verified === null) {
      await this.repository.failChallenge({
        challengeId: challenge.challengeId,
        accountId: input.accountId,
        providerSessionId: input.providerSessionId,
        purpose: "registration",
        traceId: input.traceId,
        reason: "verification_failed",
        failedAt: now,
      });
      throw verificationFailedError();
    }

    const completed = await this.repository.completeRegistration({
      challengeId: challenge.challengeId,
      accountId: input.accountId,
      providerSessionId: input.providerSessionId,
      traceId: input.traceId,
      credentialId: verified.credentialId,
      publicKey: verified.publicKey,
      counter: verified.counter,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
      transports: verified.transports,
      completedAt: now,
    });
    if (!completed) throw invalidChallengeError();
    return {
      data: {
        verified: true as const,
        credential_id: verified.credentialId,
        staff_mfa_verified: true as const,
      },
    };
  }

  public async startAuthentication(input: {
    accountId: string;
    providerSessionId: string;
  }) {
    const credentials = await this.repository.listCredentials(input.accountId);
    if (credentials.length === 0) throw enrollmentRequiredError();

    const options = await this.ceremony.generateAuthenticationOptions(credentials);
    const createdAt = this.clock();
    const challenge = await this.repository.replaceChallenge({
      accountId: input.accountId,
      providerSessionId: input.providerSessionId,
      purpose: "authentication",
      challenge: options.challenge,
      credentialLabel: null,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + challengeLifetimeMs),
    });
    return { data: { challenge_id: challenge.challengeId, public_key: options } };
  }

  public async finishAuthentication(input: {
    accountId: string;
    providerSessionId: string;
    traceId: string;
    challengeId: string;
    response: AuthenticationResponseJSON;
  }) {
    const now = this.clock();
    const [challenge, credential] = await Promise.all([
      this.repository.getActiveChallenge({
        challengeId: input.challengeId,
        accountId: input.accountId,
        providerSessionId: input.providerSessionId,
        purpose: "authentication",
        now,
      }),
      this.repository.findCredential(input.accountId, input.response.id),
    ]);
    if (challenge === null) throw invalidChallengeError();
    if (credential === null) {
      await this.repository.failChallenge({
        challengeId: challenge.challengeId,
        accountId: input.accountId,
        providerSessionId: input.providerSessionId,
        purpose: "authentication",
        traceId: input.traceId,
        reason: "credential_not_found",
        failedAt: now,
      });
      throw verificationFailedError();
    }

    const verified = await safelyVerify(() =>
      this.ceremony.verifyAuthentication({
        response: input.response,
        expectedChallenge: challenge.challenge,
        credential,
      }),
    );
    if (verified === null) {
      await this.repository.failChallenge({
        challengeId: challenge.challengeId,
        accountId: input.accountId,
        providerSessionId: input.providerSessionId,
        purpose: "authentication",
        traceId: input.traceId,
        reason: "verification_failed",
        failedAt: now,
      });
      throw verificationFailedError();
    }

    const completed = await this.repository.completeAuthentication({
      challengeId: challenge.challengeId,
      accountId: input.accountId,
      providerSessionId: input.providerSessionId,
      traceId: input.traceId,
      credentialId: credential.credentialId,
      expectedCounter: credential.counter,
      newCounter: verified.newCounter,
      deviceType: verified.deviceType,
      backedUp: verified.backedUp,
      completedAt: now,
    });
    if (!completed) throw invalidChallengeError();
    return {
      data: {
        verified: true as const,
        credential_id: credential.credentialId,
        staff_mfa_verified: true as const,
      },
    };
  }

  private async requireVerifiedSessionForAdditionalCredential(
    input: { accountId: string; providerSessionId: string },
    credentialCount: number,
  ): Promise<void> {
    if (
      credentialCount > 0 &&
      !(await this.repository.isSessionVerified(input.accountId, input.providerSessionId))
    ) {
      throw new AppError({
        code: "authentication.staff_mfa_required",
        title: "Staff MFA required",
        status: 403,
        detail: "Authenticate with a registered WebAuthn credential before adding another.",
      });
    }
  }
}

async function safelyVerify<T>(verification: () => Promise<T | null>): Promise<T | null> {
  try {
    return await verification();
  } catch {
    return null;
  }
}

function invalidChallengeError(): AppError {
  return new AppError({
    code: "authentication.webauthn_challenge_invalid",
    title: "WebAuthn challenge unavailable",
    status: 409,
    detail: "The WebAuthn challenge is expired, consumed, or belongs to another session.",
  });
}

function verificationFailedError(): AppError {
  return new AppError({
    code: "authentication.webauthn_verification_failed",
    title: "WebAuthn verification failed",
    status: 401,
    detail: "The authenticator response could not be verified.",
  });
}

function enrollmentRequiredError(): AppError {
  return new AppError({
    code: "authentication.staff_webauthn_enrollment_required",
    title: "WebAuthn enrollment required",
    status: 409,
    detail: "Register a WebAuthn credential before authenticating this staff session.",
  });
}
