import { randomBytes } from "node:crypto";

import type { VistaBloxAuth } from "./better-auth.factory.js";

const BOOTSTRAP_LIFETIME_MS = 15 * 60 * 1000;

export async function issuePasskeyBootstrap(input: {
  auth: VistaBloxAuth;
  betterAuthUserId: string;
  email: string;
  displayName: string;
  replaceCredentials: boolean;
  /** True only after OAuth plus an offline code, or an approved manual identity recovery. */
  customerIdentityVerified?: boolean;
  now?: Date;
}): Promise<string> {
  const rawContext = randomBytes(32).toString("base64url");
  const now = input.now ?? new Date();
  const context = await input.auth.$context;
  await context.internalAdapter.createVerificationValue({
    identifier: `passkey-bootstrap:${rawContext}`,
    value: JSON.stringify({
      userId: input.betterAuthUserId,
      email: input.email,
      displayName: input.displayName,
      replaceCredentials: input.replaceCredentials,
      customerIdentityVerified: input.customerIdentityVerified === true,
    }),
    expiresAt: new Date(now.getTime() + BOOTSTRAP_LIFETIME_MS),
  });
  return rawContext;
}

export function withPasskeyBootstrapContext(baseUrl: string, context: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("context", context);
  return url.toString();
}
