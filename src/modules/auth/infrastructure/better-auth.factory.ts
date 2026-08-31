import { betterAuth } from "better-auth";
import { haveIBeenPwned } from "better-auth/plugins";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { AuthAuditSink } from "../application/auth-audit-sink.js";
import { createBetterAuthAuditPlugin } from "./better-auth-audit.plugin.js";
import { createBetterAuthStaffAccountGuardPlugin } from "./better-auth-staff-account-guard.plugin.js";

export interface AuthUserSnapshot {
  id: string;
  email: string;
  emailVerified: boolean;
  population: "customer" | "staff_partner";
}

export interface BetterAuthFactoryOptions {
  database: Pool;
  baseURL: string;
  secret: string;
  secureCookies: boolean;
  trustedOrigins: string[];
  google?: {
    clientId: string;
    clientSecret: string;
  };
  onUserCreated?: (user: AuthUserSnapshot) => Promise<void>;
  onUserUpdated?: (user: AuthUserSnapshot) => Promise<void>;
  sendVerificationEmail?: (input: { to: string; verificationUrl: string }) => Promise<void>;
  sendPasswordResetEmail?: (input: { to: string; resetUrl: string }) => Promise<void>;
  onBackgroundError?: (error: unknown) => void;
  allowPopulationInput?: boolean;
  disableAutoSignIn?: boolean;
  authAuditSink?: AuthAuditSink;
}

export function createBetterAuth(options: BetterAuthFactoryOptions) {
  let clearStaffRecoveryRequirement = async (_betterAuthUserId: string): Promise<void> => {};
  const auth = betterAuth({
    appName: "VistaBlox",
    baseURL: options.baseURL,
    basePath: "/api/auth",
    secret: options.secret,
    trustedOrigins: options.trustedOrigins,
    database: options.database,
    user: {
      modelName: "auth_user",
      additionalFields: {
        population: {
          type: ["customer", "staff_partner"],
          required: true,
          defaultValue: "customer",
          input: options.allowPopulationInput === true,
        },
        disabledAt: {
          type: "date",
          required: false,
          input: false,
        },
        disabledReason: {
          type: "string",
          required: false,
          input: false,
        },
        recoveryRequiredAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },
    session: {
      modelName: "auth_session",
      expiresIn: 30 * 60,
      updateAge: 5 * 60,
    },
    account: {
      modelName: "auth_account",
      identityStrategy: "provider-id",
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
    },
    verification: {
      modelName: "auth_verification",
      storeIdentifier: "hashed",
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: options.sendVerificationEmail !== undefined,
      autoSignIn: options.disableAutoSignIn !== true,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }, request) => {
        await clearStaffRecoveryRequirement(user.id);
        if (options.authAuditSink === undefined) return;
        try {
          const eventId =
            request?.headers.get("x-vistablox-auth-event-id")?.trim() || randomUUID();
          const traceId = request?.headers.get("x-trace-id")?.trim() || null;
          await options.authAuditSink.record({
            eventKey: `better_auth:password_reset:${user.id}:${eventId}`,
            action: "authentication.password_reset",
            betterAuthUserId: user.id,
            attributeToSubject: true,
            resourceType: "account",
            resourceId: user.id,
            changes: { trace_id: traceId },
            occurredAt: new Date(),
          });
        } catch (error) {
          options.onBackgroundError?.(error);
        }
      },
      ...(options.sendPasswordResetEmail === undefined
        ? {}
        : {
            sendResetPassword: async ({ user, url }) => {
              await options.sendPasswordResetEmail?.({ to: user.email, resetUrl: url });
            },
          }),
    },
    ...(options.sendVerificationEmail === undefined
      ? {}
      : {
          emailVerification: {
            sendVerificationEmail: async ({ user, url }) => {
              void options
                .sendVerificationEmail?.({ to: user.email, verificationUrl: url })
                .catch((error: unknown) => options.onBackgroundError?.(error));
            },
          },
        }),
    ...(options.google === undefined
      ? {}
      : {
          socialProviders: {
            google: options.google,
          },
        }),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await options.onUserCreated?.(toAuthUserSnapshot(user));
          },
        },
        update: {
          after: async (user) => {
            await options.onUserUpdated?.(toAuthUserSnapshot(user));
          },
        },
      },
    },
    plugins: [
      haveIBeenPwned(),
      createBetterAuthStaffAccountGuardPlugin(),
      ...(options.authAuditSink === undefined
        ? []
        : [
            createBetterAuthAuditPlugin({
              sink: options.authAuditSink,
              identifierHashKey: options.secret,
              ...(options.onBackgroundError === undefined
                ? {}
                : { onError: options.onBackgroundError }),
            }),
          ]),
    ],
    advanced: {
      database: { joins: true },
      ipAddress: { disableIpTracking: true },
      cookiePrefix: "vb",
      useSecureCookies: options.secureCookies,
      cookies: {
        session_token: {
          name: options.secureCookies ? "__Host-vb_session" : "vb_session",
          attributes: {
            httpOnly: true,
            secure: options.secureCookies,
            sameSite: "lax",
            path: "/",
          },
        },
      },
    },
  });
  clearStaffRecoveryRequirement = async (betterAuthUserId: string) => {
    const context = await auth.$context;
    const user = await context.internalAdapter.findUserById(betterAuthUserId);
    const fields = user as (typeof user & Record<string, unknown>);
    if (
      user !== null &&
      fields.population === "staff_partner" &&
      fields.recoveryRequiredAt != null
    ) {
      await context.internalAdapter.updateUser(betterAuthUserId, {
        recoveryRequiredAt: null,
      });
    }
  };
  return auth;
}

function toAuthUserSnapshot(user: {
  id: string;
  email: string;
  emailVerified: boolean;
  population?: unknown;
}): AuthUserSnapshot {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    population: user.population === "staff_partner" ? "staff_partner" : "customer",
  };
}

export type VistaBloxAuth = ReturnType<typeof createBetterAuth>;
