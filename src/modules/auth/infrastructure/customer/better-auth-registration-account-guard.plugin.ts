import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

// Better Auth's own /unlink-account only refuses to unlink an account when
// it's the caller's *last* one (FAILED_TO_UNLINK_LAST_ACCOUNT) -- it has no
// concept of "the one used to register". Since emailAndPassword is disabled
// entirely (see better-auth.factory.ts), every customer account is created
// by its first-ever linked OAuth account, so that account's row is always
// the one with the earliest createdAt among auth_account rows for the user.
// This plugin blocks unlinking specifically that one, regardless of how
// many other providers are linked -- both for direct calls to
// /api/auth/unlink-account and for server-side auth.api.unlinkAccount()
// calls (e.g. BetterAuthLoginMethodUnlinker), since plugin hooks wrap the
// endpoint itself, not just the HTTP entry point.
export function createBetterAuthRegistrationAccountGuardPlugin(): BetterAuthPlugin {
  return {
    id: "vistablox-registration-account-guard",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/unlink-account",
          handler: createAuthMiddleware(async (ctx) => {
            const accountId = readAccountId(ctx.body);
            if (accountId === null) return;
            const session = await getSessionFromCtx(ctx);
            if (session === null) return;
            const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);
            if (findRegistrationAccountId(accounts) === accountId) {
              throw APIError.from("FORBIDDEN", {
                code: "REGISTRATION_LOGIN_METHOD_LOCKED",
                message: "The sign-in method used to create this account can't be unlinked.",
              });
            }
          }),
        },
      ],
    },
  };
}

// Exported for direct unit testing -- the guard's actual decision rule,
// independent of better-auth's request/hook plumbing.
export function findRegistrationAccountId(
  accounts: Array<{ id: string; createdAt: Date }>,
): string | null {
  const earliest = accounts.reduce<{ id: string; createdAt: Date } | null>(
    (current, candidate) => {
      if (current === null || candidate.createdAt.getTime() < current.createdAt.getTime()) {
        return candidate;
      }
      return current;
    },
    null,
  );
  return earliest?.id ?? null;
}

function readAccountId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("accountId" in body)) return null;
  const value = (body as Record<string, unknown>).accountId;
  return typeof value === "string" ? value : null;
}
