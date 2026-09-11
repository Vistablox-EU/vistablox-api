import type { IncomingHttpHeaders } from "node:http";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import type { Pool } from "pg";

import {
  reauthRequiredError,
  type AuthenticatedIdentity,
  type SessionResolver,
} from "../application/session-resolver.js";
import type { SessionMirror } from "../application/session-mirror.js";
import {
  DEVICE_SESSION_ABSOLUTE_LIFETIME_MS,
  DEVICE_SESSION_IDLE_TIMEOUT_MS,
  evaluateDeviceSessionLifetime,
} from "../domain/device-session-lifetime.js";
import {
  DEVICE_SESSION_AUTHENTICATION_LEVEL,
  REAUTH_REQUIRED_CODE,
} from "./better-auth-device-session-lifetime.plugin.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

export interface BetterAuthSessionResolverOptions {
  allowPendingOAuth?: boolean;
  // Device sessions only: last_seen_at / idle_expires_at follow activity.
  sessionMirror?: SessionMirror;
  // The mirror is a display layer, so a failed mirror write never fails the
  // request; it is reported here instead.
  onMirrorError?: (error: unknown) => void;
  clock?: () => Date;
}

export class BetterAuthSessionResolver implements SessionResolver {
  public constructor(
    private readonly auth: VistaBloxAuth,
    // Better Auth's own session table (auth_session) has no generic "update
    // an arbitrary field" API surface, so the writes this resolver needs --
    // bindDpopKey, an opportunistic bind outside the create hook, and
    // recordActivity -- go straight at the table it already owns, the same
    // connection Better Auth itself uses.
    private readonly authPool: Pool,
    private readonly options: BetterAuthSessionResolverOptions = {},
  ) {}

  public async resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null> {
    let result: Awaited<ReturnType<VistaBloxAuth["api"]["getSession"]>>;
    try {
      result = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    } catch (error) {
      // The device-session lifetime plugin's get-session hook: a
      // device_biometric session past its idle or absolute limit.
      if (error instanceof APIError && error.body?.code === REAUTH_REQUIRED_CODE) {
        throw reauthRequiredError();
      }
      throw error;
    }
    if (result === null) {
      return null;
    }
    if (result.user.disabledAt != null || result.user.recoveryRequiredAt != null) {
      return null;
    }
    const authenticationLevel = result.session.authenticationLevel;
    const accepted =
      authenticationLevel === "oauth_passkey" ||
      authenticationLevel === "staff_passkey" ||
      authenticationLevel === DEVICE_SESSION_AUTHENTICATION_LEVEL ||
      (this.options.allowPendingOAuth === true && authenticationLevel === "oauth_pending");
    if (!accepted) return null;

    const dpopJkt = (result.session as Record<string, unknown>).dpopJkt;
    return {
      betterAuthUserId: result.user.id,
      providerSessionId: result.session.id,
      population: result.user.population === "staff_partner" ? "staff_partner" : "customer",
      dpopJkt: typeof dpopJkt === "string" ? dpopJkt : null,
      sessionCreatedAt: result.session.createdAt,
      authenticationLevel,
    };
  }

  public async bindDpopKey(providerSessionId: string, jkt: string): Promise<void> {
    await this.authPool.query('UPDATE "auth_session" SET "dpopJkt" = $1 WHERE "id" = $2', [
      jkt,
      providerSessionId,
    ]);
  }

  /**
   * Device sessions only: `updatedAt` is their last-activity time (see
   * better-auth-device-session-lifetime.plugin.ts). Every other session is
   * skipped without a query. The WHERE clause re-checks the level and both
   * limits, so nothing is written to a session that has already expired.
   * GREATEST keeps the value from moving backwards when two requests
   * finish out of order.
   */
  public async recordActivity(identity: AuthenticatedIdentity): Promise<void> {
    if (identity.authenticationLevel !== DEVICE_SESSION_AUTHENTICATION_LEVEL) return;
    const now = (this.options.clock ?? (() => new Date()))();
    const updated = await this.authPool.query(
      'UPDATE "auth_session" SET "updatedAt" = GREATEST("updatedAt", $1) WHERE "id" = $2 AND "authenticationLevel" = $3 AND "createdAt" > $4 AND "updatedAt" > $5',
      [
        now,
        identity.providerSessionId,
        DEVICE_SESSION_AUTHENTICATION_LEVEL,
        new Date(now.getTime() - DEVICE_SESSION_ABSOLUTE_LIFETIME_MS),
        new Date(now.getTime() - DEVICE_SESSION_IDLE_TIMEOUT_MS),
      ],
    );
    const mirror = this.options.sessionMirror;
    if ((updated.rowCount ?? 0) === 0 || mirror?.recordActivity === undefined) return;

    const verdict = evaluateDeviceSessionLifetime({
      createdAt: identity.sessionCreatedAt,
      lastActivityAt: now,
      now,
    });
    if (verdict.status !== "active") return;
    try {
      await mirror.recordActivity({
        betterAuthSessionId: identity.providerSessionId,
        seenAt: now,
        idleExpiresAt: verdict.idleExpiresAt,
      });
    } catch (error) {
      this.options.onMirrorError?.(error);
    }
  }
}
