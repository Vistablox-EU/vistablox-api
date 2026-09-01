import type { IncomingHttpHeaders } from "node:http";
import type Provider from "oidc-provider";

import type { AuthenticatedIdentity, SessionResolver } from "../application/session-resolver.js";

/**
 * Resolves the Express.js resource-server side of native-client OIDC:
 * validates a `Bearer` access token oidc-provider itself issued, using
 * oidc-provider's own AccessToken model (so token-format handling — opaque
 * vs JWT, expiry, consumption — stays inside oidc-provider rather than
 * being re-implemented here).
 *
 * `sub`/`accountId` on the token is the better-auth user id (see
 * findAccount in oidc-provider.factory.ts), so this resolves to the same
 * AuthenticatedIdentity shape the cookie-session resolver produces and
 * require-authentication.ts needs no native-specific branch. Native OIDC
 * sign-in is customer-only (enforced in oidc-interaction.router.ts), so
 * population is always "customer" here.
 */
export class OidcBearerSessionResolver implements SessionResolver {
  public constructor(private readonly provider: Provider) {}

  public async resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null> {
    const header = headers.authorization;
    if (typeof header !== "string" || !/^bearer\s+/i.test(header)) {
      return null;
    }
    const token = header.replace(/^bearer\s+/i, "").trim();
    if (token === "") {
      return null;
    }

    const accessToken = await this.provider.AccessToken.find(token);
    if (accessToken === undefined || !accessToken.isValid) {
      return null;
    }

    return {
      betterAuthUserId: accessToken.accountId,
      providerSessionId: accessToken.grantId,
      population: "customer",
    };
  }
}
