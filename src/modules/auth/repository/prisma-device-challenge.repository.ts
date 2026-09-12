import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { CHALLENGE_REPLAY_WINDOW_MS } from "../domain/device-challenge-replay.js";
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
  }): Promise<boolean> {
    // Expiry and consumed_at both use the database's now(), like the replay
    // window and the enrolment insert deadline: no API clock is involved.
    const rows = await this.database.$queryRaw<Array<{ challenge: string }>>`
      UPDATE auth.device_challenges
      SET consumed_at = now()
      WHERE challenge = ${input.challenge}
        AND purpose = ${input.purpose}
        AND dpop_jkt = ${input.dpopJkt}
        AND device_id IS NOT DISTINCT FROM ${input.deviceId ?? null}
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING challenge
    `;
    return rows.length > 0;
  }

  public async wasConsumedWithinReplayWindow(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
  }): Promise<boolean> {
    const rows = await this.database.$queryRaw<Array<{ recent: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM auth.device_challenges
        WHERE challenge = ${input.challenge}
          AND purpose = ${input.purpose}
          AND dpop_jkt = ${input.dpopJkt}
          AND device_id IS NOT DISTINCT FROM ${input.deviceId ?? null}
          AND consumed_at >= now() - (${CHALLENGE_REPLAY_WINDOW_MS}::integer * interval '1 millisecond')
      ) AS recent
    `;
    return rows[0]?.recent === true;
  }

  public async pruneExpired(): Promise<number> {
    // The database's now(), like consumed_at and the replay window: a worker
    // with a skewed clock must not prune a row the replay decision still
    // needs.
    return this.database.$executeRaw`
      DELETE FROM auth.device_challenges
      WHERE expires_at < now() - (${CHALLENGE_REPLAY_WINDOW_MS}::integer * interval '1 millisecond')
    `;
  }
}
