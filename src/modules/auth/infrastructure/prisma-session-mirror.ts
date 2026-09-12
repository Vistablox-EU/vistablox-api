import { createHmac } from "node:crypto";

import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  RecordSessionActivityInput,
  RecordSessionCreatedInput,
  RecordSessionRevokedInput,
  SessionMirror,
} from "../application/session-mirror.js";
import { deriveDeviceLabel } from "../domain/device-label.js";

export class PrismaSessionMirror implements SessionMirror {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly hashKey: string,
  ) {}

  public async recordCreated(input: RecordSessionCreatedInput): Promise<void> {
    const account = await this.database.account.findUnique({
      where: { betterAuthUserId: input.betterAuthUserId },
      select: { id: true },
    });
    // The account is provisioned by the same user.create hook that fires
    // before any session can exist for it; a miss here means the account
    // isn't ready yet, and the mirror is a display convenience, not the
    // authorization path — silently skipping it does not affect login.
    if (account === null) return;

    await this.database.session.create({
      data: {
        id: `sess_${ulid()}`,
        accountId: account.id,
        channel: input.channel,
        betterAuthUserId: input.betterAuthUserId,
        betterAuthSessionId: input.betterAuthSessionId,
        betterAuthSessionToken: input.betterAuthSessionToken,
        authMethodAtLogin: input.authMethodAtLogin ?? "unknown",
        lastFreshAuthAt:
          input.authMethodAtLogin === "oauth_passkey" ||
          input.authMethodAtLogin === "staff_passkey"
            ? input.createdAt
            : null,
        createdAt: input.createdAt,
        lastSeenAt: input.createdAt,
        idleExpiresAt: input.idleExpiresAt,
        absoluteExpiresAt: input.absoluteExpiresAt,
        userAgentHash: input.userAgent === null ? null : this.hashUserAgent(input.userAgent),
        deviceLabel: deriveDeviceLabel(input.userAgent),
      },
    });
  }

  public async recordRevoked(input: RecordSessionRevokedInput): Promise<void> {
    await this.database.session.updateMany({
      where: { betterAuthSessionId: input.betterAuthSessionId, revokedAt: null },
      data: {
        status: "revoked",
        revokedAt: input.revokedAt,
        revocationReason: input.reason,
      },
    });
  }

  public async recordActivity(input: RecordSessionActivityInput): Promise<void> {
    await this.database.session.updateMany({
      where: { betterAuthSessionId: input.betterAuthSessionId, revokedAt: null },
      data: {
        lastSeenAt: input.seenAt,
        ...(input.idleExpiresAt === undefined ? {} : { idleExpiresAt: input.idleExpiresAt }),
      },
    });
  }

  private hashUserAgent(userAgent: string): string {
    return createHmac("sha256", this.hashKey).update(userAgent).digest("hex");
  }
}
