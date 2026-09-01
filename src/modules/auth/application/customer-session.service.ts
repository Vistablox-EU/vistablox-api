import type { IncomingHttpHeaders } from "node:http";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CustomerSessionRepository,
  CustomerSessionSummary,
} from "../repository/customer-session.repository.js";
import type { OidcGrantRepository } from "../repository/oidc-grant.repository.js";
import type { AuthAuditSink } from "./auth-audit-sink.js";
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
    private readonly auditSink?: AuthAuditSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(
    accountId: string,
    sessionId: string,
    headers: IncomingHttpHeaders,
  ): Promise<void> {
    const token = await this.repository.findOwnedSessionToken(accountId, sessionId);
    if (token !== null) {
      // Better Auth's own session.delete hook marks the mirror row revoked
      // and writes the audit entry; there is no separate write to make here.
      await this.revoker.revoke(token, headers);
      return;
    }

    if (this.grants !== undefined && (await this.grants.isOwnedByAccount(accountId, sessionId))) {
      await this.grants.revoke(sessionId);
      await recordGrantRevoked(
        this.auditSink,
        this.clock,
        accountId,
        sessionId,
        "self_revoke_one",
        headers,
      );
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
    private readonly auditSink?: AuthAuditSink,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string, headers: IncomingHttpHeaders): Promise<void> {
    const [, revokedGrantIds] = await Promise.all([
      this.revoker.revokeAll(headers),
      this.grants === undefined ? Promise.resolve<string[]>([]) : this.grants.revokeAllForAccount(accountId),
    ]);
    await Promise.all(
      revokedGrantIds.map((grantId) =>
        recordGrantRevoked(this.auditSink, this.clock, accountId, grantId, "self_revoke_all", headers),
      ),
    );
  }
}

// Better Auth's own session revocation gets its audit.audit_log entry for
// free via its session.delete hook (better-auth-audit.plugin.ts); grant
// revocation has no such hook, since oidc-provider's own adapter doesn't
// have one, so it's written explicitly here instead — the one place both
// the single- and bulk-revoke paths above go through. Matches
// SESSION_MODEL.md's "a self-revoke action should be recorded in
// audit.audit_log the same as any other security-relevant action", and
// reuses the same self_revoke_one/self_revoke_all reason vocabulary
// better-auth-audit.plugin.ts already uses for web sessions.
async function recordGrantRevoked(
  auditSink: AuthAuditSink | undefined,
  clock: () => Date,
  accountId: string,
  grantId: string,
  reason: "self_revoke_one" | "self_revoke_all",
  headers: IncomingHttpHeaders,
): Promise<void> {
  if (auditSink === undefined) return;
  await auditSink.record({
    eventKey: `oidc_grant:revoked:${grantId}`,
    action: "authentication.oidc_grant_revoked",
    betterAuthUserId: null,
    accountId,
    attributeToSubject: true,
    resourceType: "oidc_grant",
    resourceId: grantId,
    changes: { trace_id: readTraceId(headers), reason },
    occurredAt: clock(),
  });
}

function readTraceId(headers: IncomingHttpHeaders): string | null {
  const value = headers["x-trace-id"];
  const traceId = Array.isArray(value) ? value[0] : value;
  return traceId?.trim() || null;
}
