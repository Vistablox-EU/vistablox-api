import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { DeviceChallengeRepository } from "./device-challenge.repository.js";

export class PrismaDeviceChallengeRepository implements DeviceChallengeRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async issue(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    expiresAt: Date;
  }): Promise<void> {
    await this.database.deviceChallenge.create({
      data: {
        challenge: input.challenge,
        purpose: input.purpose,
        dpopJkt: input.dpopJkt,
        deviceId: input.deviceId ?? null,
        expiresAt: input.expiresAt,
      },
    });
  }

  public async consume(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.database.$queryRaw<Array<{ challenge: string }>>`
      UPDATE auth.device_challenges
      SET consumed_at = ${input.now}
      WHERE challenge = ${input.challenge}
        AND purpose = ${input.purpose}
        AND dpop_jkt = ${input.dpopJkt}
        AND device_id IS NOT DISTINCT FROM ${input.deviceId ?? null}
        AND consumed_at IS NULL
        AND expires_at > ${input.now}
      RETURNING challenge
    `;
    return rows.length > 0;
  }

  public async pruneExpired(now: Date): Promise<number> {
    const result = await this.database.deviceChallenge.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
