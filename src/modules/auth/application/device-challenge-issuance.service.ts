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
    // belongs to when L1 is sent without a device_id.
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
   * With no device_id sent, the challenge is bound to the device this DPoP
   * key belongs to, if any. A device_id that is sent is used as given; L2
   * then requires it to be the device the DPoP key resolves to. A challenge
   * is issued either way, so the answer reveals nothing about whether a
   * device exists -- and only the holder of the DPoP private key could ask.
   */
  public async issueLoginChallenge(input: {
    dpopJkt: string;
    deviceId: string | undefined;
    ttlSeconds: number;
  }): Promise<{ challenge: string; expiresAt: Date }> {
    const deviceId =
      input.deviceId ?? (await this.devices?.findByDpopJkt(input.dpopJkt))?.deviceId ?? undefined;
    return this.execute({
      purpose: "login",
      dpopJkt: input.dpopJkt,
      deviceId,
      ttlSeconds: input.ttlSeconds,
    });
  }
}
