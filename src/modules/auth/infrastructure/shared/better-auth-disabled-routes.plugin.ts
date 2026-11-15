import type { BetterAuthPlugin } from "better-auth";

import { isDisabledAuthPath } from "../../domain/disabled-auth-routes.js";

/**
 * Keeps the disabled /api/auth routes (isDisabledAuthPath) off the wire from
 * inside Better Auth, on the request its router is about to route.
 *
 * rejectDisabledAuthRoutes in front of Better Auth judges the request target
 * Express received. better-call's node adapter then builds the URL Better
 * Auth routes on from that target and from the Host and X-Forwarded-Proto
 * headers, all of them chosen by the client: a Host such as
 * "x/api/auth/passkey/delete-passkey?" moves the real target into the query
 * string, so the router sees a path Express never did. A check in front of
 * Better Auth that reads the request target alone cannot account for that.
 * This hook can, because it reads
 * `new URL(request.url).pathname`, the very expression the router routes on
 * (see better-call's router.mjs processRequest), from the very request it
 * routes. It runs ahead of every other plugin's onRequest. Server-side
 * `auth.api.*` calls do not go through the router and are unaffected.
 */
export function createBetterAuthDisabledRoutesPlugin(): BetterAuthPlugin {
  return {
    id: "vistablox-disabled-routes",
    onRequest: async (request) => {
      if (!isDisabledAuthPath(new URL(request.url).pathname)) return undefined;
      // What the router itself answers for a path it does not serve.
      return { response: new Response(null, { status: 404, statusText: "Not Found" }) };
    },
  };
}
