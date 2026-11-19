import { createCustomerSessionRouter } from "../modules/auth/api/customer/customer-session.router.js";
import { createAppConfigRouter, createDeviceAuthRouter } from "../modules/auth/api/customer/device-auth.router.js";
import { createRequireDpopOnly } from "../modules/auth/api/customer/require-dpop-only.js";
import { createSigningRequestsRouter } from "../modules/auth/api/customer/signing-requests.router.js";
import { createDeviceReplacementRouter } from "../modules/auth/api/customer/device-replacement.router.js";
import { RequestDeviceReplacementService, VerifyDeviceReplacementService } from "../modules/auth/application/customer/device-replacement.service.js";
import { ListOwnSessionsService, RevokeAllOwnSessionsService, RevokeDeviceSessionsService, RevokeOwnSessionService } from "../modules/auth/application/customer/customer-session.service.js";
import { createLoginMethodsRouter } from "../modules/auth/api/customer/login-methods.router.js";
import { UnlinkLoginMethodService } from "../modules/auth/application/customer/unlink-login-method.service.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

export function composeCustomerAuth(context: ProtectedApiContext): void {
  const { app, dependencies, requireAuthentication, requireFreshAuthentication, tightenedRateLimiter, deviceAuthDpopKeyRateLimiter } = context;
  if (dependencies.protectedApi.loginMethods !== undefined) {
    const loginMethods = dependencies.protectedApi.loginMethods;
    if (requireFreshAuthentication === undefined) {
      throw new Error(
        "protectedApi.loginMethods requires fresh-auth middleware to be constructed",
      );
    }
    app.use(
      "/v1/auth/login-methods",
      createLoginMethodsRouter(
        requireAuthentication,
        requireFreshAuthentication,
        new UnlinkLoginMethodService(loginMethods.unlinker),
      ),
    );
  }
  if (dependencies.protectedApi.deviceAuth !== undefined) {
    const deviceAuth = dependencies.protectedApi.deviceAuth;
    // device-auth's own DPoP-bound session creation (requireDpopProofFor
    // SessionCreation, inside the plugin) already depends on dpop being
    // configured -- if it weren't, E2/L2 would be broken outright, not
    // just missing replay protection here. Failing loudly at wiring time
    // beats silently skipping (jkt, jti) replay recording on this path.
    if (dependencies.protectedApi.dpop === undefined) {
      throw new Error("protectedApi.deviceAuth requires protectedApi.dpop to also be configured");
    }
    const requireDpopOnly = createRequireDpopOnly({
      baseUrl: deviceAuth.baseUrl,
      replayRepository: dependencies.protectedApi.dpop.replayRepository,
      ...(dependencies.protectedApi.dpop.replayWindowSeconds === undefined
        ? {}
        : { replayWindowSeconds: dependencies.protectedApi.dpop.replayWindowSeconds }),
    });
    // /enrol/verify and /login/verify only: the better-auth ceremony
    // behind them (auth.api.enrolVerify/loginVerify) does its own full
    // verify-and-record of this identical request's proof moments later
    // -- recordReplays: false here so the two don't record the same
    // (jkt, jti) twice against the same replay table (the ceremony's own
    // record would always lose as a replay of this one). See
    // createDeviceAuthRouter's requireDpopOnlyForVerify doc comment.
    const requireDpopOnlyForVerify = createRequireDpopOnly({
      baseUrl: deviceAuth.baseUrl,
      replayRepository: dependencies.protectedApi.dpop.replayRepository,
      recordReplays: false,
      ...(dependencies.protectedApi.dpop.replayWindowSeconds === undefined
        ? {}
        : { replayWindowSeconds: dependencies.protectedApi.dpop.replayWindowSeconds }),
    });
    app.use("/v1/app", createAppConfigRouter(requireDpopOnly, deviceAuth.appConfig));
    app.use(
      "/v1/auth/mobile",
      createDeviceAuthRouter(
        requireDpopOnly,
        deviceAuth.issueChallenge,
        deviceAuth.auth,
        requireDpopOnlyForVerify,
        [
          ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
          ...(deviceAuthDpopKeyRateLimiter === undefined ? [] : [deviceAuthDpopKeyRateLimiter]),
        ],
      ),
    );
    // T1-T3 (gated by the rollout flag: the endpoints exist behind it but
    // only answer once signing_requests flips on -- mirror the phased
    // roll-out of device_auth itself rather than shipping un-flagged
    // routes).
    if (
      deviceAuth.appConfig.features.signing_requests === true &&
      deviceAuth.signingRequests !== undefined
    ) {
      const signing = deviceAuth.signingRequests;
      app.use(
        "/v1/auth/signing-requests",
        createSigningRequestsRouter({
          requireAuthentication,
          issues: deviceAuth.issueChallenge,
          devices: signing.devices,
          requests: signing.requests,
          authorizes: signing.authorizes,
        }),
      );
    }
  }
  if (dependencies.protectedApi.deviceReplacement !== undefined) {
    const replacement = dependencies.protectedApi.deviceReplacement;
    app.use(
      "/v1/auth/mobile/replacement",
      createDeviceReplacementRouter(
        requireAuthentication,
        new RequestDeviceReplacementService(
          replacement.repository,
          replacement.emailSender,
          replacement.config,
        ),
        new VerifyDeviceReplacementService(replacement.repository, replacement.config),
      ),
    );
  }
  if (dependencies.protectedApi.customerSessions !== undefined) {
    const customerSessions = dependencies.protectedApi.customerSessions;
    if (requireFreshAuthentication === undefined) {
      throw new Error(
        "protectedApi.customerSessions requires fresh-auth middleware to be constructed",
      );
    }
    app.use(
      "/v1/auth/sessions",
      createCustomerSessionRouter(
        requireAuthentication,
        requireFreshAuthentication,
        new ListOwnSessionsService(customerSessions.repository),
        new RevokeOwnSessionService(customerSessions.repository, customerSessions.revoker),
        new RevokeAllOwnSessionsService(customerSessions.revoker),
        new RevokeDeviceSessionsService(
        customerSessions.revoker,
        customerSessions.cancelPendingSigningRequestsForDevice,
      ),
      ),
    );
  }
}
