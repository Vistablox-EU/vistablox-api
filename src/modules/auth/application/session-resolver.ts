import type { IncomingHttpHeaders } from "node:http";

export interface AuthenticatedIdentity {
  betterAuthUserId: string;
  providerSessionId: string;
  population: "customer" | "staff_partner";
  // Device binding (DPoP): the RFC 7638 thumbprint of the key this session
  // is bound to, or null for an unbound session (no proof was presented at
  // creation). Non-null means requireAuthentication must verify a fresh
  // DPoP proof against it on every request.
  dpopJkt: string | null;
  // When this session was created -- decides, for an unbound session, which
  // side of the phase-1 cutover it's on (see DPOP_PHASE1_CUTOVER_AT).
  sessionCreatedAt: Date;
}

export interface SessionResolver {
  resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null>;
  // Device binding (DPoP): binds a currently-unbound session to a key,
  // opportunistically, the first time it presents a valid proof on any
  // request (not just at creation) -- covers sessions that predate this
  // feature without forcing a re-sign-in. Optional because not every
  // SessionResolver implementation need support it.
  bindDpopKey?(providerSessionId: string, jkt: string): Promise<void>;
}
