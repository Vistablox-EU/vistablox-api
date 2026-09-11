import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import type { AccountRepository } from "../../account/repository/account.repository.js";
import { isAndroidAttestationError } from "../application/android-attestation-verifier.js";
import {
  DeviceAlreadyEnrolledError,
  DeviceChallengeExpiredError,
  DeviceLoginFailedError,
  MobilePlatformUnsupportedError,
} from "../application/device-auth-errors.js";
import {
  DeviceChallengePurposeMismatchError,
  DeviceJwsDpopMismatchError,
  DeviceJwsInvalidError,
} from "../application/device-auth-jws-verifier.js";
import type { EnrolDeviceService } from "../application/device-enrolment.service.js";
import type { LoginDeviceService } from "../application/device-login.service.js";
import { mobileAttestationSchema } from "../application/mobile-attestation.schemas.js";
import {
  assertDpopKeyMatchesPendingSession,
  requireDpopProofForSessionCreation,
  type DpopCreationContext,
  type DpopSessionCreationOptions,
} from "./dpop-session-creation.js";

export interface BetterAuthDeviceAuthPluginOptions {
  accounts: AccountRepository;
  enrolDevice: EnrolDeviceService;
  loginDevice: LoginDeviceService;
  dpop: DpopSessionCreationOptions | undefined;
}

const enrolVerifyBodySchema = z.object({
  challenge: z.string().min(1),
  jws: z.string().min(1),
  attestation: mobileAttestationSchema,
});

// device_id is optional (contract 3.1): LoginDeviceService resolves the
// device from the request's DPoP key and checks a sent device_id against it.
const loginVerifyBodySchema = z.object({
  device_id: z.string().min(1).optional(),
  challenge: z.string().min(1),
  jws: z.string().min(1),
});

/**
 * Device-key enrolment (E2) and login (L2), section 3.4/3.5 of
 * docs/plans/device-bound-auth-backend.md. These endpoints do their own
 * full verification (challenge, device-auth JWS, Android attestation) --
 * they are never called with a pre-trusted userId, and are safe even
 * though better-auth auto-mounts them at /api/auth/device/... too (an
 * unused, never client-facing path; mobile only ever calls the /v1
 * wrapper in device-auth.router.ts, which relays here via auth.api.*).
 * Registered after bearer()/the DPoP plugin, same ordering rule as every
 * other plugin in this factory's plugins array.
 */
export function createBetterAuthDeviceAuthPlugin(
  options: BetterAuthDeviceAuthPluginOptions,
): BetterAuthPlugin {
  return {
    id: "vistablox-device-auth",
    endpoints: {
      enrolVerify: createAuthEndpoint(
        "/device/enrol/verify",
        { method: "POST", body: enrolVerifyBodySchema },
        async (ctx) => {
          const dpopContext: DpopCreationContext = {
            headers: ctx.headers,
            request: ctx.request,
            path: ctx.path,
          };

          const current = await getSessionFromCtx(ctx);
          const level = (current?.session as Record<string, unknown> | undefined)
            ?.authenticationLevel;
          if (current === null || level !== "oauth_pending") {
            // Contract 3.6: DEVICE_JWS_INVALID is 400.
            throw APIError.from("BAD_REQUEST", {
              code: "DEVICE_JWS_INVALID",
              message: "A pending Google/Apple sign-in session is required before enrolling a device.",
            });
          }

          // The pending session must ALREADY be bound to this exact DPoP key
          // -- not merely presenting *a* valid proof. An unbound session
          // (Phase 1 allows sign-in without a DPoP proof) must be refused
          // outright here, not silently bound to whatever key shows up:
          // otherwise a stolen oauth_pending bearer token plus an
          // attacker's own DPoP key would be enough to enrol a device on
          // someone else's account. assertDpopKeyMatchesPendingSession also
          // does the actual verify+record (once, cached for the
          // session.create.before hook this same request is about to fire)
          // -- see isSessionUpgradeCeremonyPath's own comment for why the
          // generic DPoP plugin hook does not also do this for this path.
          const boundJkt = (current.session as Record<string, unknown>).dpopJkt;
          if (typeof boundJkt !== "string") {
            // Contract 3.6: DEVICE_JWS_INVALID is 400.
            throw APIError.from("BAD_REQUEST", {
              code: "DEVICE_JWS_INVALID",
              message: "This session is not yet bound to a device key.",
            });
          }
          await assertDpopKeyMatchesPendingSession(dpopContext, boundJkt, options.dpop);

          const account = await options.accounts.findByBetterAuthUserId(current.user.id);
          if (account === null) {
            throw APIError.from("INTERNAL_SERVER_ERROR", {
              code: "device.account_mapping_missing",
              message: "The authenticated identity is not linked to a VistaBlox account.",
            });
          }
          if (account.status !== "active") {
            throw accountRestricted();
          }

          try {
            const device = await options.enrolDevice.execute({
              accountId: account.accountId,
              betterAuthUserId: current.user.id,
              dpopJkt: boundJkt,
              challenge: ctx.body.challenge,
              jws: ctx.body.jws,
              attestation: {
                platform: ctx.body.attestation.platform,
                keyAttestationChain:
                  ctx.body.attestation.platform === "android"
                    ? ctx.body.attestation.key_attestation_chain
                    : [],
                integrityToken:
                  ctx.body.attestation.platform === "android"
                    ? ctx.body.attestation.integrity_token
                    : undefined,
                model: undefined,
                osVersion: undefined,
                appVersion: undefined,
              },
            });

            try {
              // Just the userId: internalAdapter.createSession's 2nd param
              // is dontRememberMe (a boolean), not a context -- the request
              // context it needs comes from tryGetCurrentAuthEndpointContext's
              // continuation-local lookup automatically, confirmed against
              // internal-adapter.mjs directly rather than assumed.
              const session = await ctx.context.internalAdapter.createSession(current.user.id);
              if (session === null) {
                throw APIError.from("INTERNAL_SERVER_ERROR", {
                  code: "device.session_creation_failed",
                  message: "Could not create a session for the enrolled device.",
                });
              }
              await setSessionCookie(ctx, { session, user: current.user });
              // The pending session's job is done -- mirrors the passkey
              // ceremony's own priorSessionToken/deleteSession pattern (E2
              // "rotates" per the wire contract, section 3.1).
              await ctx.context.internalAdapter.deleteSession(current.session.token);

              return ctx.json({
                device_id: device.deviceId,
                status: "active" as const,
                session_expires_at: session.expiresAt.toISOString(),
                authentication_level: "device_biometric" as const,
              });
            } catch (error) {
              // The device row is already committed (Prisma) by this
              // point; internalAdapter.createSession uses a different
              // client (better-auth's own pg Pool), so this couldn't have
              // been one transaction. Compensate rather than leave an
              // orphaned active device blocking every retry via the
              // one-active-device-per-account constraint -- confirmed
              // live on staging: a real enrolment crashed exactly here and
              // did exactly that, before this existed. Best-effort: if the
              // rollback itself fails, still surface the original error,
              // not the cleanup failure.
              await options.enrolDevice.rollback(device.deviceId).catch((rollbackError: unknown) => {
                ctx.context.logger?.warn?.("failed to roll back an orphaned device after a failed enrolment", {
                  deviceId: device.deviceId,
                  rollbackError,
                });
              });
              throw error;
            }
          } catch (error) {
            logAttestationRejection(ctx, error);
            throw toApiError(error);
          }
        },
      ),
      loginVerify: createAuthEndpoint(
        "/device/login/verify",
        { method: "POST", body: loginVerifyBodySchema },
        async (ctx) => {
          const dpopContext: DpopCreationContext = {
            headers: ctx.headers,
            request: ctx.request,
            path: ctx.path,
          };
          // Contract 3.5: L2's auth is "none" -- a stale Authorization
          // header must never be a reason to fail (there's no session yet
          // for a bearer token to belong to).
          const dpopClaims = await requireDpopProofForSessionCreation(
            dpopContext,
            options.dpop,
            true,
          );

          try {
            const device = await options.loginDevice.execute({
              deviceId: ctx.body.device_id,
              dpopJkt: dpopClaims.jkt,
              challenge: ctx.body.challenge,
              jws: ctx.body.jws,
            });

            // A closed/suspended account otherwise keeps its devices fully
            // able to log in -- device status and account status are
            // separate, and closing/restricting an account today doesn't
            // touch its devices at all.
            const account = await options.accounts.findByBetterAuthUserId(device.betterAuthUserId);
            if (account === null || account.status !== "active") {
              throw accountRestricted();
            }

            const session = await ctx.context.internalAdapter.createSession(
              device.betterAuthUserId,
            );
            if (session === null) {
              throw APIError.from("INTERNAL_SERVER_ERROR", {
                code: "device.session_creation_failed",
                message: "Could not create a session for this device.",
              });
            }
            const user = await ctx.context.internalAdapter.findUserById(device.betterAuthUserId);
            if (user === null) {
              throw APIError.from("INTERNAL_SERVER_ERROR", {
                code: "device.account_mapping_missing",
                message: "The device's account could not be found.",
              });
            }
            await setSessionCookie(ctx, { session, user });

            return ctx.json({
              device_id: device.deviceId,
              session_expires_at: session.expiresAt.toISOString(),
              authentication_level: "device_biometric" as const,
            });
          } catch (error) {
            logAttestationRejection(ctx, error);
            throw toApiError(error);
          }
        },
      ),
    },
  };
}

// Contract error code ACCOUNT_RESTRICTED (403) -- "Account frozen or
// closed", section 3.6. A closed/suspended account's devices otherwise stay
// fully able to enrol/log in: device status is entirely separate from
// account status, and closing an account today doesn't touch its devices.
export function accountRestricted(): APIError {
  return APIError.from("FORBIDDEN", {
    code: "ACCOUNT_RESTRICTED",
    message: "This account can't be used right now.",
  });
}

// Structural, not better-auth's own Logger type: this file doesn't need
// the rest of that type's surface, just .warn, and staying structural
// avoids depending on an internal type this codebase doesn't otherwise
// import from.
interface MinimalContextLogger {
  context: { logger?: { warn?: (message: string, data?: Record<string, unknown>) => void } };
  path?: string;
}

// The client-facing message never carries an AndroidAttestationInvalidError's
// specific reason (see toApiError below) -- it's still worth keeping
// somewhere, so a real rejection has more to go on in the logs than "it
// failed". Only Android-attestation errors carry a reason (their
// constructor's whole argument); every other device-auth error's message
// is already the safe, generic one (see each class's own doc comment).
export function logAttestationRejection(ctx: MinimalContextLogger, error: unknown): void {
  if (isAndroidAttestationError(error)) {
    ctx.context.logger?.warn?.("device-auth attestation rejected", {
      code: error.code,
      reason: error.message,
      path: ctx.path ?? "unknown",
    });
  }
}

// HTTP status per contract section 3.6 -- not a blanket 401. Attacker-
// reachable detail is still kept out of the response either way: every one
// of these error classes' own .message is written to be safe to return
// as-is (see each class's own doc comment), never the verifier's specific
// internal rejection reason (that's logged server-side only -- see
// AndroidAttestationInvalidError's construction sites, which never surface
// their `reason` argument to the client).
export function toApiError(error: unknown): APIError {
  if (error instanceof APIError) return error;
  if (
    error instanceof DeviceChallengeExpiredError ||
    error instanceof DeviceChallengePurposeMismatchError ||
    error instanceof DeviceJwsInvalidError ||
    error instanceof DeviceJwsDpopMismatchError
  ) {
    return APIError.from("BAD_REQUEST", { code: error.code, message: error.message });
  }
  if (isAndroidAttestationError(error)) {
    // Never the verifier's specific internal reason (error.message) -- it's
    // an oracle a forger could use to iterate towards a chain that passes.
    // The caller logs the real reason server-side before calling this.
    return APIError.from("BAD_REQUEST", {
      code: error.code,
      message: "This device can't be used for VistaBlox.",
    });
  }
  if (error instanceof DeviceAlreadyEnrolledError) {
    return APIError.from("CONFLICT", { code: error.code, message: error.message });
  }
  if (error instanceof DeviceLoginFailedError) {
    return APIError.from("UNAUTHORIZED", { code: error.code, message: error.message });
  }
  if (error instanceof MobilePlatformUnsupportedError) {
    return APIError.from("BAD_REQUEST", {
      code: error.code,
      message: "This mobile platform is not supported yet.",
    });
  }
  throw error;
}
