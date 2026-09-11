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
  DevicePairingNotImplementedError,
} from "../application/device-auth-errors.js";
import { DeviceChallengePurposeMismatchError, DeviceJwsInvalidError } from "../application/device-auth-jws-verifier.js";
import type { EnrolDeviceService } from "../application/device-enrolment.service.js";
import type { LoginDeviceService } from "../application/device-login.service.js";
import {
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

const androidAttestationSchema = z.object({
  platform: z.literal("android"),
  key_attestation_chain: z.array(z.string()),
  integrity_token: z.string().optional(),
});

const enrolVerifyBodySchema = z.object({
  challenge: z.string().min(1),
  jws: z.string().min(1),
  attestation: androidAttestationSchema,
});

const loginVerifyBodySchema = z.object({
  device_id: z.string().min(1),
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
          const dpopClaims = await requireDpopProofForSessionCreation(dpopContext, options.dpop);

          const current = await getSessionFromCtx(ctx);
          const level = (current?.session as Record<string, unknown> | undefined)
            ?.authenticationLevel;
          if (current === null || level !== "oauth_pending") {
            throw APIError.from("UNAUTHORIZED", {
              code: "DEVICE_JWS_INVALID",
              message: "A pending Google/Apple sign-in session is required before enrolling a device.",
            });
          }

          const account = await options.accounts.findByBetterAuthUserId(current.user.id);
          if (account === null) {
            throw APIError.from("INTERNAL_SERVER_ERROR", {
              code: "device.account_mapping_missing",
              message: "The authenticated identity is not linked to a VistaBlox account.",
            });
          }

          try {
            const device = await options.enrolDevice.execute({
              accountId: account.accountId,
              betterAuthUserId: current.user.id,
              dpopJkt: dpopClaims.jkt,
              challenge: ctx.body.challenge,
              jws: ctx.body.jws,
              attestation: {
                platform: ctx.body.attestation.platform,
                keyAttestationChain: ctx.body.attestation.key_attestation_chain,
                integrityToken: ctx.body.attestation.integrity_token,
                model: undefined,
                osVersion: undefined,
                appVersion: undefined,
              },
            });

            // Just the userId: internalAdapter.createSession's 2nd param is
            // dontRememberMe (a boolean), not a context -- the request
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

            return ctx.json({
              device_id: device.deviceId,
              status: "active" as const,
              session_expires_at: session.expiresAt.toISOString(),
              authentication_level: "device_biometric" as const,
            });
          } catch (error) {
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
          const dpopClaims = await requireDpopProofForSessionCreation(dpopContext, options.dpop);

          try {
            const device = await options.loginDevice.execute({
              deviceId: ctx.body.device_id,
              dpopJkt: dpopClaims.jkt,
              challenge: ctx.body.challenge,
              jws: ctx.body.jws,
            });

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
            throw toApiError(error);
          }
        },
      ),
    },
  };
}

function toApiError(error: unknown): APIError {
  if (error instanceof APIError) return error;
  if (
    error instanceof DeviceChallengeExpiredError ||
    error instanceof DeviceAlreadyEnrolledError ||
    error instanceof DeviceLoginFailedError ||
    error instanceof DeviceJwsInvalidError ||
    error instanceof DeviceChallengePurposeMismatchError ||
    isAndroidAttestationError(error)
  ) {
    return APIError.from("UNAUTHORIZED", { code: error.code, message: error.message });
  }
  if (error instanceof DevicePairingNotImplementedError) {
    return APIError.from("NOT_IMPLEMENTED", { code: error.code, message: error.message });
  }
  throw error;
}
