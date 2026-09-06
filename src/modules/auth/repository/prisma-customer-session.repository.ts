import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
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
    }));
  }

  public async findOwnedSessionToken(accountId: string, sessionId: string): Promise<string | null> {
    const row = await this.database.session.findFirst({
      where: { id: sessionId, accountId },
      select: { betterAuthSessionToken: true },
    });
    return row?.betterAuthSessionToken ?? null;
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
