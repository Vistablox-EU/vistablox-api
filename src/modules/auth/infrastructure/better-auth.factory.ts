import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { APIError, getSessionFromCtx } from "better-auth/api";
import type { Pool } from "pg";

import type { AuthAuditSink } from "../application/auth-audit-sink.js";
import type { SessionMirror } from "../application/session-mirror.js";
import type { LoginMethodType } from "../../account/repository/account.repository.js";
import { createBetterAuthAuditPlugin } from "./better-auth-audit.plugin.js";
import { createBetterAuthStaffAccountGuardPlugin } from "./better-auth-staff-account-guard.plugin.js";
import { createBetterAuthRegistrationAccountGuardPlugin } from "./better-auth-registration-account-guard.plugin.js";

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
  apple?: {
    clientId: string;
    createClientSecret: () => Promise<string>;
  };
  webauthn?: {
    rpId: string;
    origins: string[];
  };
  onUserCreated?: (user: AuthUserSnapshot) => Promise<void>;
  onUserUpdated?: (user: AuthUserSnapshot) => Promise<void>;
  onLoginMethodUsed?: (input: {
    betterAuthUserId: string;
    methodType: LoginMethodType;
    occurredAt: Date;
  }) => Promise<void>;
  onBackgroundError?: (error: unknown) => void;
  allowPopulationInput?: boolean;
  authAuditSink?: AuthAuditSink;
  sessionMirror?: SessionMirror;
}

export function createBetterAuth(options: BetterAuthFactoryOptions) {
  const defaultOrigin = new URL(options.baseURL).origin;
  const rpId = options.webauthn?.rpId ?? new URL(defaultOrigin).hostname;
  const origins = options.webauthn?.origins ?? [defaultOrigin];
  // Lets the admin frontend (a separate subdomain, not a separate origin in
  // the eTLD+1 sense) read the same session cookie as this API -- only
  // meaningful once rpId actually looks like "api.vistablox.io" (three-plus
  // labels); on "localhost" (one label) there is no shared parent domain to
  // scope a cookie to, so this stays off there. Assumes a single level of
  // subdomain nesting under the shared root, matching the one real
  // deployment shape today -- revisit the derivation if that ever changes.
  const hostnameLabels = rpId.split(".");
  const crossSubDomainCookieDomain =
    hostnameLabels.length >= 3 ? `.${hostnameLabels.slice(1).join(".")}` : undefined;
  const apple = options.apple;
  const socialProviders = {
    ...(options.google === undefined ? {} : { google: options.google }),
    ...(apple === undefined
      ? {}
      : {
          apple: async () => ({
            clientId: apple.clientId,
            clientSecret: await apple.createClientSecret(),
          }),
        }),
  };
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
      additionalFields: {
        authenticationLevel: {
          type: ["unassured", "oauth_pending", "oauth_passkey", "staff_passkey"],
          required: true,
          defaultValue: "unassured",
          input: false,
        },
      },
    },
    account: {
      modelName: "auth_account",
      identityStrategy: "provider-id",
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        // Google verifies email ownership, and password sign-in no longer
        // exists in the mobile client (removed in the OAuth+passkey
        // rewrite) -- without this, every pre-existing password-only
        // account has no self-service path back in.
        trustedProviders: ["google"],
        // better-auth's own default (true) additionally requires the
        // *existing* local account to have already verified its email
        // before allowing a trusted provider to link -- moot here, since
        // SMTP_HOST is still a placeholder (smtp.example.com) in production
        // and verification emails have never been deliverable, so a
        // pre-existing password account can never satisfy this on its own.
        // Google's real-time proof of ownership is the same signal
        // trustedProviders above already relies on, so requiring it a
        // second time from account creation is redundant here.
        requireLocalEmailVerified: false,
        allowDifferentEmails: false,
      },
    },
    verification: {
      modelName: "auth_verification",
      storeIdentifier: "hashed",
    },
    emailAndPassword: { enabled: false },
    socialProviders,
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            if (
              isOAuthSignInCompletionPath(context?.path) &&
              user.emailVerified !== true
            ) {
              throw APIError.from("FORBIDDEN", {
                code: "OAUTH_EMAIL_NOT_VERIFIED",
                message: "The identity provider did not verify this email address.",
              });
            }
          },
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
      session: {
        create: {
          before: async (session, context) => ({
            data: {
              ...session,
              authenticationLevel: await resolveAuthenticationLevel(
                session.userId,
                context,
              ),
            },
          }),
        },
      },
    },
    plugins: [
      expo(),
      // Native mobile no longer goes through a separate OIDC bearer-token
      // subsystem (removed -- confirmed nothing ever authenticated through
      // it, oidc_model_instances had zero rows in production): the session
      // itself, sent as a bearer token via the Authorization header instead
      // of a cookie, now covers that case directly.
      bearer(),
      passkey({
        rpID: rpId,
        rpName: "VistaBlox",
        origin: origins,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        registration: {
          requireSession: false,
          resolveUser: async ({ ctx, context }) => {
            const bootstrap = await readPasskeyBootstrap(ctx, context);
            return {
              id: bootstrap.userId,
              name: bootstrap.email,
              displayName: bootstrap.displayName,
            };
          },
          afterVerification: async ({ ctx, user, context }) => {
            const pendingBootstrap = context == null
              ? null
              : await readPasskeyBootstrap(ctx, context);
            const priorSessionToken = await assertPasskeyCeremonyAuthorized(
              ctx,
              user.id,
              pendingBootstrap?.customerIdentityVerified === true,
            );
            if (context === null || context === undefined) {
              const existing = await ctx.context.adapter.findMany({
                model: "passkey",
                where: [{ field: "userId", value: user.id }],
                limit: 1,
              });
              if (existing.length !== 0) {
                throw APIError.from("FORBIDDEN", {
                  code: "PASSKEY_ALREADY_ENROLLED",
                  message:
                    "A passkey is already enrolled. Use account recovery to replace it.",
                });
              }
            } else {
              const bootstrap = await consumePasskeyBootstrap(ctx, context);
              if (bootstrap.userId !== user.id) throw invalidPasskeyBootstrap();
              if (bootstrap.replaceCredentials) {
                await ctx.context.adapter.deleteMany({
                  model: "passkey",
                  where: [{ field: "userId", value: user.id }],
                });
              }
              const storedUser = await ctx.context.internalAdapter.findUserById(user.id);
              if (
                storedUser !== null &&
                (storedUser as Record<string, unknown>).recoveryRequiredAt != null
              ) {
                await ctx.context.internalAdapter.updateUser(user.id, {
                  recoveryRequiredAt: null,
                });
              }
            }
            if (priorSessionToken !== null) {
              await ctx.context.internalAdapter.deleteSession(priorSessionToken);
            }
          },
        },
        authentication: {
          afterVerification: async ({ ctx, clientData }) => {
            const credential = await ctx.context.adapter.findOne({
              model: "passkey",
              where: [{ field: "credentialID", value: clientData.id }],
            });
            if (
              typeof credential !== "object" ||
              credential === null ||
              !("userId" in credential) ||
              typeof credential.userId !== "string"
            ) {
              throw oauthPasskeyRequired();
            }
            const priorSessionToken = await assertPasskeyCeremonyAuthorized(
              ctx,
              credential.userId,
              false,
            );
            if (priorSessionToken !== null) {
              await ctx.context.internalAdapter.deleteSession(priorSessionToken);
            }
          },
        },
      }),
      createBetterAuthStaffAccountGuardPlugin(),
      createBetterAuthRegistrationAccountGuardPlugin(),
      ...(options.authAuditSink === undefined
        ? []
        : [
            createBetterAuthAuditPlugin({
              sink: options.authAuditSink,
              identifierHashKey: options.secret,
              ...(options.onBackgroundError === undefined
                ? {}
                : { onError: options.onBackgroundError }),
              ...(options.sessionMirror === undefined
                ? {}
                : { sessionMirror: options.sessionMirror }),
              ...(options.onLoginMethodUsed === undefined
                ? {}
                : { onLoginMethodUsed: options.onLoginMethodUsed }),
            }),
          ]),
    ],
    advanced: {
      database: { joins: true },
      ipAddress: { disableIpTracking: true },
      cookiePrefix: "vb",
      useSecureCookies: options.secureCookies,
      ...(crossSubDomainCookieDomain === undefined
        ? {}
        : {
            crossSubDomainCookies: {
              enabled: true,
              domain: crossSubDomainCookieDomain,
            },
          }),
      cookies: {
        // No custom `name` here: the client only recognizes and reacts to
        // cookies whose wire name contains "session_token" (its
        // hasBetterAuthCookies/hasSessionCookieChanged checks are
        // string-based, not aware of cookiePrefix's semantics). Overriding
        // the name to something like "vb_session" silently breaks that
        // detection -- the cookie gets set but the client never notices,
        // so sign-in "succeeds" yet the app never leaves the login screen.
        // cookiePrefix above already gives it the "vb." prefix; that's the
        // customization this needs.
        session_token: {
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
  return auth;

  async function resolveAuthenticationLevel(
    userId: string,
    context: {
      path?: string;
      context: {
        internalAdapter: { findUserById: (id: string) => Promise<unknown> };
      };
    } | null,
  ): Promise<"unassured" | "oauth_pending" | "oauth_passkey" | "staff_passkey"> {
    const user = await authContextUser(userId, context);
    if (isStaffAuthUser(user) && isPasskeyVerificationPath(context?.path)) {
      return "staff_passkey";
    }
    if (isPasskeyVerificationPath(context?.path)) return "oauth_passkey";
    if (isOAuthSignInCompletionPath(context?.path)) return "oauth_pending";
    return "unassured";
  }
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

interface PasskeyBootstrapValue {
  userId: string;
  email: string;
  displayName: string;
  replaceCredentials: boolean;
  customerIdentityVerified: boolean;
}

async function readPasskeyBootstrap(
  ctx: { context: { internalAdapter: { findVerificationValue(identifier: string): Promise<unknown> } } },
  rawContext: string | null | undefined,
): Promise<PasskeyBootstrapValue> {
  if (!rawContext) throw invalidPasskeyBootstrap();
  const stored = await ctx.context.internalAdapter.findVerificationValue(
    `passkey-bootstrap:${rawContext}`,
  );
  return parsePasskeyBootstrap(stored);
}

async function consumePasskeyBootstrap(
  ctx: { context: { internalAdapter: { consumeVerificationValue(identifier: string): Promise<unknown> } } },
  rawContext: string,
): Promise<PasskeyBootstrapValue> {
  const stored = await ctx.context.internalAdapter.consumeVerificationValue(
    `passkey-bootstrap:${rawContext}`,
  );
  return parsePasskeyBootstrap(stored);
}

function parsePasskeyBootstrap(input: unknown): PasskeyBootstrapValue {
  if (typeof input !== "object" || input === null || !("value" in input)) {
    throw invalidPasskeyBootstrap();
  }
  try {
    const parsed = JSON.parse(String((input as { value: unknown }).value)) as Record<string, unknown>;
    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.displayName !== "string" ||
      typeof parsed.replaceCredentials !== "boolean" ||
      typeof parsed.customerIdentityVerified !== "boolean"
    ) {
      throw invalidPasskeyBootstrap();
    }
    return {
      userId: parsed.userId,
      email: parsed.email,
      displayName: parsed.displayName,
      replaceCredentials: parsed.replaceCredentials,
      customerIdentityVerified: parsed.customerIdentityVerified,
    };
  } catch (error) {
    if (error instanceof APIError) throw error;
    throw invalidPasskeyBootstrap();
  }
}

function invalidPasskeyBootstrap(): APIError {
  return APIError.from("UNAUTHORIZED", {
    code: "PASSKEY_BOOTSTRAP_INVALID",
    message: "This passkey enrollment link is invalid or expired.",
  });
}

async function assertPasskeyCeremonyAuthorized(
  ctx: Parameters<typeof getSessionFromCtx>[0],
  passkeyUserId: string,
  customerIdentityVerifiedByBootstrap: boolean,
): Promise<string | null> {
  const user = await ctx.context.internalAdapter.findUserById(passkeyUserId);
  if (isStaffAuthUser(user) || customerIdentityVerifiedByBootstrap) return null;

  const current = await getSessionFromCtx(ctx);
  const level = (current?.session as Record<string, unknown> | undefined)?.authenticationLevel;
  if (
    current?.user.id !== passkeyUserId ||
    (level !== "oauth_pending" && level !== "oauth_passkey")
  ) {
    throw oauthPasskeyRequired();
  }
  return current.session.token;
}

function oauthPasskeyRequired(): APIError {
  return APIError.from("UNAUTHORIZED", {
    code: "OAUTH_REQUIRED_BEFORE_PASSKEY",
    message: "Continue with Google or Apple before confirming your passkey.",
  });
}

function isPasskeyVerificationPath(path: string | undefined): boolean {
  return path === "/passkey/verify-authentication" || path === "/passkey/verify-registration";
}

// "/callback/google"/"/callback/apple" is the browser-redirect completion
// of a social sign-in. "/sign-in/social" reaches here too, for the mobile
// client's native idToken exchange (authClient.signIn.social({ idToken })):
// better-auth's own sign-in.mjs cryptographically verifies that token
// (verifyProviderIdToken) before ever calling handleOAuthUserInfo, so a
// user/session actually being created at this path is already proof
// verification succeeded. That same endpoint's *other* branch (no idToken --
// returns an authorize URL for the browser to redirect to) never creates a
// user or session, so it can never reach either hook below with this path
// value; there is no unverified way to arrive here.
function isOAuthSignInCompletionPath(path: string | undefined): boolean {
  return (
    path === "/callback/google" ||
    path === "/callback/apple" ||
    path === "/sign-in/social"
  );
}

function isStaffAuthUser(user: unknown): boolean {
  return (
    typeof user === "object" &&
    user !== null &&
    (user as Record<string, unknown>).population === "staff_partner"
  );
}

async function authContextUser(
  userId: string,
  context: { context?: { internalAdapter?: { findUserById?: (id: string) => Promise<unknown> } } } | null,
): Promise<unknown> {
  return context?.context?.internalAdapter?.findUserById?.(userId);
}
