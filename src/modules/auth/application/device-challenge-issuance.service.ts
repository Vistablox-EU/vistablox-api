import { randomBytes } from "node:crypto";

import type { DeviceChallengeRepository } from "../repository/device-challenge.repository.js";
import type { DeviceRepository } from "../repository/device.repository.js";

// 256 bits, comfortably over the contract's ">=128-bit random" floor.
const CHALLENGE_BYTES = 32;

export class IssueDeviceChallengeService {
  public constructor(
    private readonly repository: DeviceChallengeRepository,
    private readonly clock: () => Date = () => new Date(),
    // Used only by issueLoginChallenge, to find the device a DPoP key
    // belongs to.
    private readonly devices?: Pick<DeviceRepository, "findByDpopJkt">,
  ) {}

  public async execute(input: {
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    ttlSeconds: number;
  }): Promise<{ challenge: string; expiresAt: Date }> {
    const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");
    const expiresAt = new Date(this.clock().getTime() + input.ttlSeconds * 1000);
    await this.repository.issue({
      challenge,
      purpose: input.purpose,
      dpopJkt: input.dpopJkt,
      deviceId: input.deviceId,
      expiresAt,
    });
    return { challenge, expiresAt };
  }

  /**
   * L1. Contract 3.1: the device is resolved from the request's DPoP key.
   * The challenge is bound to the device this DPoP key belongs to whenever
   * there is one, whatever device_id was sent; L2 then refuses a sent
   * device_id that isn't that device (DEVICE_LOGIN_FAILED), so every
   * mismatch ends the same way. A sent device_id is used only when the key
   * belongs to no device. A challenge is issued either way, so the answer
   * reveals nothing about whether a device exists -- and only the holder of
   * the DPoP private key could ask.
   */
  public async issueLoginChallenge(input: {
    dpopJkt: string;
    deviceId: string | undefined;
    ttlSeconds: number;
  }): Promise<{ challenge: string; expiresAt: Date }> {
    const keysDevice = (await this.devices?.findByDpopJkt(input.dpopJkt))?.deviceId;
    return this.execute({
      purpose: "login",
      dpopJkt: input.dpopJkt,
      deviceId: keysDevice ?? input.deviceId,
      ttlSeconds: input.ttlSeconds,
    });
  }
}
