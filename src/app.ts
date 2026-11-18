import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { requestLogSerializer } from "./infrastructure/logging/request-log-redaction.js";
import { rejectDisabledAuthRoutes } from "./modules/auth/api/shared/reject-disabled-auth.js";
import { createHealthRouter } from "./modules/health/health.router.js";
import { createOfferingRouter } from "./modules/offering/api/offering.router.js";
import { ListPublicOfferingsService } from "./modules/offering/application/list-public-offerings.service.js";
import { createCoinbaseOnrampWebhookRouter } from "./modules/offering/api/coinbase-onramp-webhook.router.js";
import { errorHandler } from "./shared/http/error-handler.js";
import { notFoundHandler } from "./shared/http/not-found.js";
import { requestContext } from "./shared/http/request-context.js";
import { BASELINE_RATE_LIMIT, TIGHTENED_RATE_LIMIT, createRateLimiter, dpopKeyRateLimitSubject } from "./shared/http/rate-limit.js";
import { createIdempotencyMiddleware } from "./shared/http/idempotency.js";
import { composeProtectedApi } from "./composition/compose-protected-api.js";
export type { AppDependencies } from "./composition/app-dependencies.js";
import type { AppDependencies } from "./composition/app-dependencies.js";

export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  if (dependencies.trustProxy !== undefined) {
    app.set("trust proxy", dependencies.trustProxy);
  }
  const listPublicOfferings = new ListPublicOfferingsService(dependencies.offeringRepository);
  const baselineRateLimiter =
    dependencies.rateLimitStore === undefined
      ? undefined
      : createRateLimiter(dependencies.rateLimitStore, BASELINE_RATE_LIMIT);
  const tightenedRateLimiter =
    dependencies.rateLimitStore === undefined
      ? undefined
      : createRateLimiter(dependencies.rateLimitStore, TIGHTENED_RATE_LIMIT);
  // Device-auth challenge issuance (E1/L1) has no account yet, so the default
  // subject falls back to IP alone -- a second limiter keyed on the DPoP key
  // itself closes the gap a fresh keypair per call would otherwise leave.
  const deviceAuthDpopKeyRateLimiter =
    dependencies.rateLimitStore === undefined
      ? undefined
      : createRateLimiter(dependencies.rateLimitStore, TIGHTENED_RATE_LIMIT, dpopKeyRateLimitSubject);

  // AD-057/AD-147: the high-risk writes that exist are reservation funding
  // initiation, investor reconfirmation submission, and the finalization-batch
  // action. Each mounts the shared Idempotency-Key middleware with a stable
  // endpoint identifier of its own, supplied here (the mount site), keyed on
  // the same audit.idempotency_keys table. Refunds, payouts, reservation
  // cancellation and legal direct-contact release are future work and will
  // mount the same middleware when they land.
  const reservationCreateIdempotency =
    dependencies.idempotencyStore === undefined
      ? undefined
      : createIdempotencyMiddleware(dependencies.idempotencyStore, "offering.reservation.create");
  const reconfirmIdempotency =
    dependencies.idempotencyStore === undefined
      ? undefined
      : createIdempotencyMiddleware(dependencies.idempotencyStore, "offering.reservation.reconfirm");
  const finalizeIdempotency =
    dependencies.idempotencyStore === undefined
      ? undefined
      : createIdempotencyMiddleware(dependencies.idempotencyStore, "offering.finalize");

  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(
    pinoHttp<Request, Response>({
      logger: dependencies.logger,
      genReqId: (_request, response) => String(response.locals.traceId),
      customAttributeKeys: { reqId: "trace_id" },
      // pino-http gives its child logger the stock req serializer, which
      // overrides any serializer set on the logger itself, so this has to be
      // passed here.
      serializers: { req: requestLogSerializer },
    }),
  );
  app.use((request, response, next) => {
    response.locals.logger = request.log;
    next();
  });
  app.use(cors({ origin: dependencies.corsOrigins, credentials: true }));
  app.use(helmet());
  if (dependencies.passkeyAssociations?.appleTeamId !== undefined) {
    app.get("/.well-known/apple-app-site-association", (_request, response) => {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.json({
        webcredentials: {
          apps: [
            `${dependencies.passkeyAssociations?.appleTeamId}.${dependencies.passkeyAssociations?.appleBundleId}`,
          ],
        },
      });
    });
  }
  if (dependencies.passkeyAssociations?.androidCertificateFingerprints !== undefined) {
    app.get("/.well-known/assetlinks.json", (_request, response) => {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.json([
        {
          relation: [
            "delegate_permission/common.handle_all_urls",
            "delegate_permission/common.get_login_creds",
          ],
          target: {
            namespace: "android_app",
            package_name: dependencies.passkeyAssociations?.androidPackageName,
            sha256_cert_fingerprints:
              dependencies.passkeyAssociations?.androidCertificateFingerprints,
          },
        },
      ]);
    });
  }
  // WebAuthn Related Origin Requests: a browser on a listed origin (the
  // admin console) fetches this from the rpId's host -- this API, #51 --
  // before letting that origin run a ceremony for the rpId. Fetched with no
  // credentials or referrer; the data is public, so any origin may read it
  // (ACAO *, credentials off) and helmet's same-origin CORP is lifted.
  const relatedOrigins = dependencies.webauthnRelatedOrigins ?? [];
  if (relatedOrigins.length > 0) {
    app.get("/.well-known/webauthn", (_request, response) => {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.removeHeader("Access-Control-Allow-Credentials");
      response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      response.json({ origins: relatedOrigins });
    });
  }
  if (dependencies.authHandler !== undefined) {
    app.all(
      "/api/auth/*splat",
      rejectDisabledAuthRoutes,
      ...(tightenedRateLimiter === undefined ? [] : [tightenedRateLimiter]),
      dependencies.authHandler,
    );
  }
  if (dependencies.coinbaseOnrampWebhook !== undefined) {
    // Ahead of express.json: the HMAC covers the exact bytes CDP sent, so this
    // route needs the raw body, not a re-serialised parse of it.
    app.use(
      "/webhooks/coinbase-onramp",
      express.raw({ limit: "256kb", type: "application/json" }),
      createCoinbaseOnrampWebhookRouter(
        dependencies.coinbaseOnrampWebhook.verifier,
        dependencies.coinbaseOnrampWebhook.receiveWebhook,
      ),
    );
  }
  app.use(express.json({ limit: "1mb", type: "application/json" }));

  app.use("/health", createHealthRouter(dependencies.databaseProbe));
  app.use(
    "/v1/offerings",
    ...(baselineRateLimiter === undefined ? [] : [baselineRateLimiter]),
    createOfferingRouter(listPublicOfferings),
  );
  composeProtectedApi(app, dependencies, {
    baselineRateLimiter,
    tightenedRateLimiter,
    deviceAuthDpopKeyRateLimiter,
    reservationCreateIdempotency,
    reconfirmIdempotency,
    finalizeIdempotency,
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
