import type { IncomingHttpHeaders } from "node:http";

import type { AuthenticatedIdentity, SessionResolver } from "./session-resolver.js";

/**
 * Tries each resolver in order and returns the first non-null identity —
 * lets a single require-authentication.ts middleware accept either the web
 * cookie session or a native OIDC bearer token without either resolver
 * knowing about the other.
 */
export class CompositeSessionResolver implements SessionResolver {
  public constructor(private readonly resolvers: readonly SessionResolver[]) {}

  public async resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null> {
    for (const resolver of this.resolvers) {
      const identity = await resolver.resolve(headers);
      if (identity !== null) {
        return identity;
      }
    }
    return null;
  }
}
