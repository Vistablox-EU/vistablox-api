import type { IncomingHttpHeaders } from "node:http";

import { AppError } from "../../../../shared/errors/app-error.js";
import { canSessionStillAuthenticate } from "../../domain/session-liveness.js";
import type {
  CustomerSessionRepository,
  CustomerSessionSummary,
} from "../../repository/customer/customer-session.repository.js";
import type { SessionRevoker } from "./session-revoker.js";

export interface OwnSessionSummary extends CustomerSessionSummary {
  isCurrent: boolean;
}

export class ListOwnSessionsService {
  public constructor(
    private readonly repository: CustomerSessionRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * The caller's sessions: those that can still authenticate, plus revoked
   * history. A session that has merely timed out is left out. The mirror
   * keeps calling it 'active' (nothing moves the column when a session
   * expires), so passing the stored status through would offer a dead session
   * as live. The caller's own session is always kept: it has just
   * authenticated, so a lagging row must not hide it from its own list.
   */
  public async execute(
    accountId: string,
    currentProviderSessionId: string,
  ): Promise<OwnSessionSummary[]> {
    const now = this.clock();
    const sessions = await this.repository.listForAccount(accountId);
    return sessions
      .map((session) => ({
        ...session,
        isCurrent: session.betterAuthSessionId === currentProviderSessionId,
      }))
      .filter(
        (session) =>
          session.isCurrent ||
          canSessionStillAuthenticate({
            status: session.status,
            betterAuthSessionId: session.betterAuthSessionId,
            providerSession: session.providerSession,
            now,
          }),
      );
  }
}

export class RevokeOwnSessionService {
  public constructor(
    private readonly repository: CustomerSessionRepository,
    private readonly revoker: SessionRevoker,
  ) {}

  public async execute(
    accountId: string,
    sessionId: string,
    headers: IncomingHttpHeaders,
  ): Promise<void> {
    const providerSessionId = await this.repository.findOwnedProviderSessionId(accountId, sessionId);
    if (providerSessionId === null) {
      throw new AppError({
        code: "resource.not_found",
        title: "Session not found",
        status: 404,
        detail: "No session with that ID belongs to this account.",
      });
    }

    // Better Auth's own session.delete hook marks the mirror row revoked
    // and writes the audit entry; there is no separate write to make here.
    await this.revoker.revoke(providerSessionId, headers);
  }
}

// Matches "revoke all sessions" conventions elsewhere (GitHub, Google, etc.):
// this also ends the caller's own current session, not just every other one
// — there is no separate "log out everywhere but here" action.
export class RevokeAllOwnSessionsService {
  public constructor(private readonly revoker: SessionRevoker) {}

  public async execute(headers: IncomingHttpHeaders): Promise<void> {
    await this.revoker.revokeAll(headers);
  }
}

// Device binding (DPoP) "Remove this phone": ends every one of the caller's
// own sessions bound to a given key, not just the current one -- the point
// is removing a specific physical device's access, which may span more than
// one still-live session for that key.
export class RevokeDeviceSessionsService {
  public constructor(private readonly revoker: SessionRevoker) {}

  public async execute(jkt: string, headers: IncomingHttpHeaders): Promise<{ revokedCount: number }> {
    const revokedCount = await this.revoker.revokeByDpopKey(jkt, headers);
    return { revokedCount };
  }
}
