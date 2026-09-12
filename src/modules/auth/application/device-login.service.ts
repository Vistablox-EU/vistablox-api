import {
  DeviceChallengeExpiredError,
  DeviceChallengeReplayedError,
  DeviceLoginFailedError,
  MobilePlatformUnsupportedError,
} from "./device-auth-errors.js";
import { replayWindowStart } from "../domain/device-challenge-replay.js";
import { isDeviceAuthJwsVerificationError, verifyDeviceAuthJws } from "./device-auth-jws-verifier.js";
import type { Device, DeviceRepository } from "../repository/device.repository.js";
import type { DeviceChallengeRepository } from "../repository/device-challenge.repository.js";
import {
  ANDROID_ONLY_MOBILE_PLATFORM_POLICY,
  isMobilePlatform,
  isMobilePlatformSupported,
  type MobilePlatformPolicy,
} from "../domain/mobile-platform.policy.js";

const LOGIN_PURPOSE = "login";

export class LoginDeviceService {
  public constructor(
    private readonly challengeRepository: DeviceChallengeRepository,
    private readonly deviceRepository: DeviceRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly mobilePlatformPolicy: MobilePlatformPolicy = ANDROID_ONLY_MOBILE_PLATFORM_POLICY,
  ) {}

  // Re-attestation (attestation_required) isn't implemented in this PR --
  // L1 always answers attestation_required: false, and L2 never asks for
  // one. A deliberate scope trim for single-device enrolment/login, not an
  // oversight; revisit once step-up re-attestation is actually needed.
  public async execute(input: {
    /** Optional (contract 3.1); when sent, it must be the device this DPoP key belongs to. */
    deviceId: string | undefined;
    /** From the request's verified DPoP proof: decides which device this is. */
    dpopJkt: string;
    challenge: string;
    jws: string;
  }): Promise<Device> {
    // Contract 3.1: the device is the one this request's DPoP key belongs
    // to. Only the holder of that key's private half can present a proof
    // for it, and the JWS below must still verify against the device's
    // stored biometric key.
    const device = await this.deviceRepository.findByDpopJkt(input.dpopJkt);
    // Deliberately the same generic failure for "no device for this key",
    // "revoked device", "device_id doesn't match", and "bad signature"
    // below (contract 3.6: DEVICE_LOGIN_FAILED is undifferentiated, to
    // avoid account/device enumeration).
    if (
      device === null ||
      device.status !== "active" ||
      (input.deviceId !== undefined && input.deviceId !== device.deviceId)
    ) {
      throw new DeviceLoginFailedError();
    }
    if (
      !isMobilePlatform(device.platform) ||
      !isMobilePlatformSupported(device.platform, this.mobilePlatformPolicy)
    ) {
      throw new MobilePlatformUnsupportedError(device.platform);
    }

    const now = this.clock();
    const consumed = await this.challengeRepository.consume({
      challenge: input.challenge,
      purpose: LOGIN_PURPOSE,
      dpopJkt: input.dpopJkt,
      deviceId: device.deviceId,
      now,
    });
    if (!consumed) {
      // Same code semantics as enrolment (domain/device-challenge-replay.ts).
      const recentlyUsed = await this.challengeRepository.wasConsumedSince({
        challenge: input.challenge,
        purpose: LOGIN_PURPOSE,
        dpopJkt: input.dpopJkt,
        // The device the challenge was bound to (resolved from the DPoP key,
        // contract 3.1), not the optional body device_id.
        deviceId: device.deviceId,
        since: replayWindowStart(now),
      });
      throw recentlyUsed ? new DeviceChallengeReplayedError() : new DeviceChallengeExpiredError();
    }

    try {
      await verifyDeviceAuthJws({
        jws: input.jws,
        expectedPurpose: LOGIN_PURPOSE,
        expectedChallenge: input.challenge,
        expectedDeviceId: device.deviceId,
        // A client that lost its device_id (e.g. an enrolment response that
        // never arrived) can sign without the claim; the challenge is
        // already bound to this device. A claim that is present must match.
        deviceIdClaimOptional: true,
        storedPublicJwk: device.biometricPublicJwk,
        expectedDpopJkt: undefined,
        now: this.clock(),
      });
    } catch (error) {
      if (isDeviceAuthJwsVerificationError(error)) {
        throw new DeviceLoginFailedError();
      }
      throw error;
    }

    await this.deviceRepository.touchLastSeen(device.deviceId, this.clock());
    return device;
  }
}
