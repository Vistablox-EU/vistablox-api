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
                  if (isDisabledUser(user)) {
                    throw APIError.from("FORBIDDEN", {
                      code: "STAFF_ACCOUNT_DISABLED",
                      message: "This staff account has been disabled.",
                    });
                  }
                  if (isRecoveryPendingUser(user)) {
                    throw APIError.from("FORBIDDEN", {
                      code: "STAFF_ACCOUNT_RECOVERY_REQUIRED",
                      message: "Complete staff account recovery before signing in.",
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
