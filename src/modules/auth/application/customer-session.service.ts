import type { IncomingHttpHeaders } from "node:http";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CustomerSessionRepository,
  CustomerSessionSummary,
} from "../repository/customer-session.repository.js";
import type { SessionRevoker } from "./session-revoker.js";

export interface OwnSessionSummary extends CustomerSessionSummary {
  isCurrent: boolean;
}

export class ListOwnSessionsService {
  public constructor(private readonly repository: CustomerSessionRepository) {}

  public async execute(
    accountId: string,
    currentProviderSessionId: string,
  ): Promise<OwnSessionSummary[]> {
    const sessions = await this.repository.listForAccount(accountId);
    return sessions.map((session) => ({
      ...session,
      isCurrent: session.betterAuthSessionId === currentProviderSessionId,
    }));
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
    const token = await this.repository.findOwnedSessionToken(accountId, sessionId);
    if (token === null) {
      throw new AppError({
        code: "resource.not_found",
        title: "Session not found",
        status: 404,
        detail: "No session with that ID belongs to this account.",
      });
    }

    // Better Auth's own session.delete hook marks the mirror row revoked
    // and writes the audit entry; there is no separate write to make here.
    await this.revoker.revoke(token, headers);
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
