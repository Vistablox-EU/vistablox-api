import { randomBytes } from "node:crypto";

import type { DeviceChallengeRepository } from "../repository/device-challenge.repository.js";

// 256 bits, comfortably over the contract's ">=128-bit random" floor.
const CHALLENGE_BYTES = 32;

export class IssueDeviceChallengeService {
  public constructor(
    private readonly repository: DeviceChallengeRepository,
    private readonly clock: () => Date = () => new Date(),
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
}
