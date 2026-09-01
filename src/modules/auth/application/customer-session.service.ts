import type { IncomingHttpHeaders } from "node:http";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CustomerSessionRepository,
  CustomerSessionSummary,
} from "../repository/customer-session.repository.js";
import type { OidcGrantRepository } from "../repository/oidc-grant.repository.js";
import type { SessionRevoker } from "./session-revoker.js";

export interface OwnSessionSummary extends CustomerSessionSummary {
  isCurrent: boolean;
}

const NATIVE_GRANT_DEVICE_LABEL = "VistaBlox Mobile/Desktop";
const NATIVE_GRANT_AUTH_METHOD = "oidc_pkce";

// SESSION_MODEL.md's unified endpoint presents Better Auth's session mirror
// and oidc-provider's grant store as one list, using the same fields
// (channel, device label, last seen, status) rather than a separate shape
// per source. Native grants don't track distinct last-activity, so
// lastSeenAt falls back to createdAt for them.
export class ListOwnSessionsService {
  public constructor(
    private readonly repository: CustomerSessionRepository,
    private readonly grants?: OidcGrantRepository,
  ) {}

  public async execute(
    accountId: string,
    currentProviderSessionId: string,
  ): Promise<OwnSessionSummary[]> {
    const sessions = await this.repository.listForAccount(accountId);
    const webRows: OwnSessionSummary[] = sessions.map((session) => ({
      ...session,
      isCurrent: session.betterAuthSessionId === currentProviderSessionId,
    }));

    if (this.grants === undefined) {
      return webRows;
    }

    const grants = await this.grants.listForAccount(accountId);
    const grantRows: OwnSessionSummary[] = grants.map((grant) => ({
      sessionId: grant.grantId,
      channel: "native",
      deviceLabel: NATIVE_GRANT_DEVICE_LABEL,
      authMethodAtLogin: NATIVE_GRANT_AUTH_METHOD,
      createdAt: grant.createdAt,
      lastSeenAt: grant.createdAt,
      status: grant.status,
      revocationReason: null,
      betterAuthSessionId: null,
      isCurrent: grant.grantId === currentProviderSessionId,
    }));

    return [...webRows, ...grantRows];
  }
}

export class RevokeOwnSessionService {
  public constructor(
    private readonly repository: CustomerSessionRepository,
    private readonly revoker: SessionRevoker,
    private readonly grants?: OidcGrantRepository,
  ) {}

  public async execute(
    accountId: string,
    sessionId: string,
    headers: IncomingHttpHeaders,
  ): Promise<void> {
    const token = await this.repository.findOwnedSessionToken(accountId, sessionId);
    if (token !== null) {
      // Better Auth's own session.delete hook marks the mirror row revoked;
      // there is no separate write to make here.
      await this.revoker.revoke(token, headers);
      return;
    }

    if (this.grants !== undefined && (await this.grants.isOwnedByAccount(accountId, sessionId))) {
      await this.grants.revoke(sessionId);
      return;
    }

    throw new AppError({
      code: "resource.not_found",
      title: "Session not found",
      status: 404,
      detail: "No session with that ID belongs to this account.",
    });
  }
}

// SESSION_MODEL.md: "lets the customer revoke one session, one grant, or
// all of them". Matches "revoke all sessions" conventions elsewhere (GitHub,
// Google, etc.): this also ends the caller's own current session/grant,
// not just every other one — there is no separate "log out everywhere but
// here" action.
export class RevokeAllOwnSessionsService {
  public constructor(
    private readonly revoker: SessionRevoker,
    private readonly grants?: OidcGrantRepository,
  ) {}

  public async execute(accountId: string, headers: IncomingHttpHeaders): Promise<void> {
    await Promise.all([
      this.revoker.revokeAll(headers),
      this.grants === undefined ? undefined : this.grants.revokeAllForAccount(accountId),
    ]);
  }
}
