import { betterAuth } from "better-auth";
import { haveIBeenPwned } from "better-auth/plugins";
import type { Pool } from "pg";

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
}

export function createBetterAuth(options: BetterAuthFactoryOptions) {
  return betterAuth({
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
      revokeSessionsOnPasswordReset: true,
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
    plugins: [haveIBeenPwned()],
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
