import { APIError } from "better-auth/api";

export function createBetterAuthStaffAccountGuardPlugin() {
  return {
    id: "vistablox-staff-account-guard",
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                before: async (
                  session: { userId: string },
                  context: {
                    context: {
                      internalAdapter: {
                        findUserById: (userId: string) => Promise<unknown>;
                      };
                    };
                  } | null,
                ) => {
                  if (context === null) return;
                  const user = await context.context.internalAdapter.findUserById(
                    session.userId,
                  );
                  if (isOAuthSignInCompletionPath(contextPath(context)) && !isVerifiedEmailUser(user)) {
                    throw APIError.from("FORBIDDEN", {
                      code: "OAUTH_EMAIL_NOT_VERIFIED",
                      message: "The identity provider did not verify this email address.",
                    });
                  }
                  if (isDisabledUser(user)) {
                    throw APIError.from("FORBIDDEN", {
                      code: "STAFF_ACCOUNT_DISABLED",
                      message: "This staff account has been disabled.",
                    });
                  }
                  if (isRecoveryPendingUser(user) && !isRecoveryCompletionPath(contextPath(context))) {
                    throw APIError.from("FORBIDDEN", {
                      code: "STAFF_ACCOUNT_RECOVERY_REQUIRED",
                      message: "Complete staff account recovery before signing in.",
                    });
                  }
                  if (isStaffUser(user) && !isStaffPasskeyPath(contextPath(context))) {
                    throw APIError.from("FORBIDDEN", {
                      code: "STAFF_PASSKEY_REQUIRED",
                      message: "Staff accounts can only sign in with a passkey.",
                    });
                  }
                },
              },
            },
          },
        },
      };
    },
  };
}

function isVerifiedEmailUser(user: unknown): boolean {
  return (
    typeof user === "object" &&
    user !== null &&
    "emailVerified" in user &&
    (user as Record<string, unknown>).emailVerified === true
  );
}

function contextPath(context: unknown): string | null {
  if (typeof context !== "object" || context === null || !("path" in context)) return null;
  const path = (context as Record<string, unknown>).path;
  return typeof path === "string" ? path : null;
}

function isStaffPasskeyPath(path: string | null): boolean {
  return path === "/passkey/verify-authentication" || path === "/passkey/verify-registration";
}

function isRecoveryCompletionPath(path: string | null): boolean {
  return path === "/passkey/verify-registration";
}

// "/sign-in/social" also counts as a completed OAuth sign-in here, for the
// mobile client's native idToken exchange -- better-auth verifies that
// token cryptographically before ever creating a session, so reaching this
// hook with that path is already proof it succeeded. In practice a staff
// user is rejected below by isStaffPasskeyPath regardless (staff can only
// sign in with a passkey), so this mainly closes the gap for consistency
// rather than a currently-reachable one. See better-auth.factory.ts's
// isOAuthSignInCompletionPath for the fuller reasoning (duplicated here
// since this plugin has no shared import for it).
function isOAuthSignInCompletionPath(path: string | null): boolean {
  return path === "/callback/google" || path === "/callback/apple" || path === "/sign-in/social";
}

function isStaffUser(user: unknown): boolean {
  return (
    typeof user === "object" &&
    user !== null &&
    "population" in user &&
    (user as Record<string, unknown>).population === "staff_partner"
  );
}

function isRecoveryPendingUser(user: unknown): boolean {
  return (
    typeof user === "object" &&
    user !== null &&
    "recoveryRequiredAt" in user &&
    (user as Record<string, unknown>).recoveryRequiredAt != null
  );
}

function isDisabledUser(user: unknown): boolean {
  return (
    typeof user === "object" &&
    user !== null &&
    "disabledAt" in user &&
    (user as Record<string, unknown>).disabledAt != null
  );
}
