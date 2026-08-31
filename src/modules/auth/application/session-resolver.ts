import type { IncomingHttpHeaders } from "node:http";

export interface AuthenticatedIdentity {
  betterAuthUserId: string;
  providerSessionId: string;
  population: "customer" | "staff_partner";
}

export interface SessionResolver {
  resolve(headers: IncomingHttpHeaders): Promise<AuthenticatedIdentity | null>;
}
