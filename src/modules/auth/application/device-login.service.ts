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
    deviceId: string;
    dpopJkt: string;
    challenge: string;
    jws: string;
  }): Promise<Device> {
    const device = await this.deviceRepository.findByDeviceId(input.deviceId);
    // Deliberately the same generic failure for "unknown device", "wrong
    // key", and "kid mismatch" below (contract 3.6: DEVICE_LOGIN_FAILED is
    // undifferentiated, to avoid account/device enumeration).
    if (device === null || device.status !== "active" || device.dpopJkt !== input.dpopJkt) {
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
      deviceId: input.deviceId,
      now,
    });
    if (!consumed) {
      // Same code semantics as enrolment (domain/device-challenge-replay.ts).
      const recentlyUsed = await this.challengeRepository.wasConsumedSince({
        challenge: input.challenge,
        purpose: LOGIN_PURPOSE,
        dpopJkt: input.dpopJkt,
        deviceId: input.deviceId,
        since: replayWindowStart(now),
      });
      throw recentlyUsed ? new DeviceChallengeReplayedError() : new DeviceChallengeExpiredError();
    }

    try {
      await verifyDeviceAuthJws({
        jws: input.jws,
        expectedPurpose: LOGIN_PURPOSE,
        expectedChallenge: input.challenge,
        expectedDeviceId: input.deviceId,
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
