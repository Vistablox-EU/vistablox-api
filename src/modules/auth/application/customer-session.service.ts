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

// SESSION_MODEL.md's unified endpoint also merges in oidc-provider's grant
// store; that half is deferred until native-client OIDC exists (no grants
// to unify yet), so this lists the Better Auth session mirror only.
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
    // Better Auth's own session.delete hook marks the mirror row revoked;
    // there is no separate write to make here.
    await this.revoker.revoke(token, headers);
  }
}
