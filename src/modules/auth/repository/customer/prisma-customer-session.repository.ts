import type { DatabaseClient } from "../../../../infrastructure/database/prisma.js";
import type { ProviderSessionFacts } from "../../domain/session-liveness.js";
import type {
  CustomerSessionRepository,
  CustomerSessionSummary,
} from "./customer-session.repository.js";

export class PrismaCustomerSessionRepository implements CustomerSessionRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listForAccount(accountId: string): Promise<CustomerSessionSummary[]> {
    const rows = await this.database.session.findMany({
      where: { accountId },
      orderBy: { lastSeenAt: "desc" },
    });
    // Only rows the mirror still calls 'active' need a second opinion: the
    // mirror is never told when such a session merely times out.
    const providerSessions = await this.findProviderSessions(
      rows.flatMap((row) =>
        row.status === "active" && row.betterAuthSessionId !== null ? [row.betterAuthSessionId] : [],
      ),
    );
    return rows.map((row) => ({
      sessionId: row.id,
      channel: row.channel,
      deviceLabel: row.deviceLabel,
      authMethodAtLogin: row.authMethodAtLogin,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      status: row.status,
      revocationReason: row.revocationReason,
      betterAuthSessionId: row.betterAuthSessionId,
      providerSession:
        row.betterAuthSessionId === null ? null : (providerSessions.get(row.betterAuthSessionId) ?? null),
    }));
  }

  /**
   * Better-auth's own session rows, by ID. auth_session is owned by
   * better-auth and has no Prisma model, so it is read with a raw query,
   * the same table BetterAuthSessionResolver already reads and writes.
   */
  private async findProviderSessions(ids: string[]): Promise<Map<string, ProviderSessionFacts>> {
    if (ids.length === 0) return new Map();
    const rows = await this.database.$queryRaw<
      Array<{
        id: string;
        authenticationLevel: string;
        createdAt: Date;
        updatedAt: Date;
        expiresAt: Date;
      }>
    >`
      SELECT "id", "authenticationLevel", "createdAt", "updatedAt", "expiresAt"
      FROM "auth_session"
      WHERE "id" = ANY(${ids}::text[])
    `;
    return new Map(
      rows.map((row) => [
        row.id,
        {
          authenticationLevel: row.authenticationLevel,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          expiresAt: row.expiresAt,
        },
      ]),
    );
  }

  public async findOwnedProviderSessionId(accountId: string, sessionId: string): Promise<string | null> {
    const row = await this.database.session.findFirst({
      where: { id: sessionId, accountId },
      select: { betterAuthSessionId: true },
    });
    return row?.betterAuthSessionId ?? null;
  }

  public async hasFreshAuthentication(input: {
    accountId: string;
    providerSessionId: string;
    freshAfter: Date;
  }): Promise<boolean> {
    const session = await this.database.session.findFirst({
      where: {
        accountId: input.accountId,
        betterAuthSessionId: input.providerSessionId,
        status: "active",
        lastFreshAuthAt: { gte: input.freshAfter },
      },
      select: { id: true },
    });
    return session !== null;
  }
}
