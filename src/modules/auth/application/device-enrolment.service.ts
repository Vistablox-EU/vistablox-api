import {
  type PlayIntegrityPolicy,
  type PlayIntegrityVerdictDecoder,
  type AndroidAttestationRevocationList,
  AndroidAttestationInvalidError,
  verifyAndroidKeyAttestation,
  verifyPlayIntegrityToken,
} from "./android-attestation-verifier.js";
import {
  DeviceAlreadyEnrolledError,
  DeviceChallengeExpiredError,
  DevicePairingNotImplementedError,
} from "./device-auth-errors.js";
import { verifyDeviceAuthJws } from "./device-auth-jws-verifier.js";
import type { Device, DeviceRepository } from "../repository/device.repository.js";
import type { DeviceChallengeRepository } from "../repository/device-challenge.repository.js";

const ENROL_PURPOSE = "enrol-device";

export interface AndroidAttestationConfig {
  policy: PlayIntegrityPolicy;
  pinnedRootCertificates: string[];
  certDigestAllowlist: string[];
  revocationList: AndroidAttestationRevocationList;
  /** Required whenever `policy` isn't "disabled". */
  playIntegrityDecoder: PlayIntegrityVerdictDecoder | undefined;
}

export interface EnrolDeviceInput {
  accountId: string;
  betterAuthUserId: string;
  dpopJkt: string;
  challenge: string;
  jws: string;
  attestation: {
    platform: string;
    keyAttestationChain: string[];
    integrityToken: string | undefined;
    model: string | undefined;
    osVersion: string | undefined;
    appVersion: string | undefined;
  };
}

export class EnrolDeviceService {
  public constructor(
    private readonly challengeRepository: DeviceChallengeRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly android: AndroidAttestationConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: EnrolDeviceInput): Promise<Device> {
    // Checked before the challenge is consumed: pairing isn't built yet in
    // this PR, and a doomed request shouldn't burn a single-use challenge
    // to find that out.
    const existingActiveDevice = await this.deviceRepository.findActiveDeviceForAccount(
      input.accountId,
    );
    if (existingActiveDevice !== null) {
      throw new DevicePairingNotImplementedError();
    }

    const consumed = await this.challengeRepository.consume({
      challenge: input.challenge,
      purpose: ENROL_PURPOSE,
      now: this.clock(),
    });
    if (consumed === null) {
      throw new DeviceChallengeExpiredError();
    }

    const claims = await verifyDeviceAuthJws({
      jws: input.jws,
      expectedPurpose: ENROL_PURPOSE,
      expectedChallenge: input.challenge,
      expectedDeviceId: undefined,
      storedPublicJwk: undefined,
      now: this.clock(),
    });

    const alreadyEnrolled = await this.deviceRepository.findByDpopJkt(input.dpopJkt);
    if (alreadyEnrolled !== null) {
      throw new DeviceAlreadyEnrolledError();
    }

    if (input.attestation.platform !== "android") {
      throw new AndroidAttestationInvalidError(
        `platform "${input.attestation.platform}" is not yet supported`,
      );
    }
    await verifyAndroidKeyAttestation({
      certificateChain: input.attestation.keyAttestationChain,
      pinnedRootCertificates: this.android.pinnedRootCertificates,
      certDigestAllowlist: this.android.certDigestAllowlist,
      challenge: input.challenge,
      bioJkt: claims.bioJkt,
      revocationList: this.android.revocationList,
      now: this.clock(),
    });
    await this.verifyPlayIntegrity(input, claims.bioJkt);

    return this.deviceRepository.create({
      accountId: input.accountId,
      betterAuthUserId: input.betterAuthUserId,
      dpopJkt: input.dpopJkt,
      bioJkt: claims.bioJkt,
      biometricPublicJwk: claims.jwk as unknown as Record<string, unknown>,
      platform: input.attestation.platform,
      model: input.attestation.model,
      osVersion: input.attestation.osVersion,
      appVersion: input.attestation.appVersion,
      attestationMetadata: {
        keyAttestationChain: input.attestation.keyAttestationChain,
      },
    });
  }

  private async verifyPlayIntegrity(input: EnrolDeviceInput, bioJkt: string): Promise<void> {
    if (this.android.policy !== "disabled" && this.android.playIntegrityDecoder === undefined) {
      throw new AndroidAttestationInvalidError(
        "Play Integrity policy requires a decoder, but none is configured",
      );
    }
    await verifyPlayIntegrityToken({
      policy: this.android.policy,
      token: input.attestation.integrityToken,
      challenge: input.challenge,
      bioJkt,
      certDigestAllowlist: this.android.certDigestAllowlist,
      // Only ever called when policy !== "disabled", where the check above
      // has already guaranteed a decoder exists.
      decoder: this.android.playIntegrityDecoder as PlayIntegrityVerdictDecoder,
    });
  }
}
