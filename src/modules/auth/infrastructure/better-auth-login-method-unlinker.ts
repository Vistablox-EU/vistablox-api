import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import { isAPIError } from "better-auth/api";

import {
  LoginMethodNotLinkedError,
  RegistrationLoginMethodLockedError,
  type LoginMethodUnlinker,
  type UnlinkableLoginMethodType,
} from "../application/login-method-unlinker.js";
import type { VistaBloxAuth } from "./better-auth.factory.js";

// The registration guard lives in
// better-auth-registration-account-guard.plugin.ts, applied to
// /unlink-account itself -- it fires the same way whether that endpoint is
// reached over HTTP or, as here, via auth.api.unlinkAccount(), so there is
// no separate "which account is the registration one" check to duplicate.
export class BetterAuthLoginMethodUnlinker implements LoginMethodUnlinker {
  public constructor(private readonly auth: VistaBloxAuth) {}

  public async unlink(
    methodType: UnlinkableLoginMethodType,
    headers: IncomingHttpHeaders,
  ): Promise<void> {
    const requestHeaders = fromNodeHeaders(headers);
    const accounts = await this.auth.api.listUserAccounts({ headers: requestHeaders });
    const linked = accounts.find((account) => account.providerId === methodType);
    if (linked === undefined) {
      throw new LoginMethodNotLinkedError(methodType);
    }
    try {
      await this.auth.api.unlinkAccount({
        headers: requestHeaders,
        body: { accountId: linked.id },
      });
    } catch (error) {
      const code = errorCode(error);
      // FAILED_TO_UNLINK_LAST_ACCOUNT is Better Auth's own "can't unlink your
      // only account" guard -- reachable only when the sole linked account
      // is also the registration one, so it means the same thing here.
      if (code === "REGISTRATION_LOGIN_METHOD_LOCKED" || code === "FAILED_TO_UNLINK_LAST_ACCOUNT") {
        throw new RegistrationLoginMethodLockedError(methodType);
      }
      if (code === "ACCOUNT_NOT_FOUND") {
        throw new LoginMethodNotLinkedError(methodType);
      }
      throw error;
    }
  }
}

function errorCode(error: unknown): string | null {
  if (!isAPIError(error)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null || !("code" in body)) return null;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}
