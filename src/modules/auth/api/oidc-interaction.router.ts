import { Router } from "express";
import type Provider from "oidc-provider";

import { AppError } from "../../../shared/errors/app-error.js";
import type { SessionResolver } from "../application/session-resolver.js";

/**
 * oidc-provider types interaction prompt `details` as an untyped object;
 * these are the well-known field names it populates for the "consent"
 * prompt (see oidc-provider's own documented interactions recipe).
 */
interface ConsentPromptDetails {
  missingOIDCScope?: string[];
  missingOIDCClaims?: string[];
  missingResourceScopes?: Record<string, string[]>;
}

/**
 * The interaction endpoints oidc-provider redirects the caller to
 * (see interactions.url in oidc-provider.factory.ts). This is deliberately
 * a JSON API, not a server-rendered login page: the native client renders
 * its own UI and calls better-auth's existing credential endpoints
 * directly, then retries the GET here — the same delegation-to-better-auth
 * principle SESSION_MODEL.md requires, reusing the identical SessionResolver
 * already used for web authentication rather than a second credential
 * check.
 */
export function createOidcInteractionRouter(
  provider: Provider,
  betterAuthSessions: SessionResolver,
): Router {
  const router = Router();

  router.get("/:uid", async (request, response) => {
    const details = await provider.interactionDetails(request, response);

    if (details.prompt.name === "login") {
      const identity = await betterAuthSessions.resolve(request.headers);
      if (identity === null) {
        throw new AppError({
          code: "authentication.required",
          title: "Authentication required",
          status: 401,
          detail:
            "Sign in first (POST /api/auth/sign-in/email or /sign-in/social), then retry this interaction.",
        });
      }
      if (identity.population !== "customer") {
        throw new AppError({
          code: "oidc.customer_only",
          title: "Native sign-in unavailable",
          status: 403,
          detail: "Native-client sign-in is only available to customer accounts.",
        });
      }

      await provider.interactionFinished(
        request,
        response,
        { login: { accountId: identity.betterAuthUserId, remember: false } },
        { mergeWithLastSubmission: false },
      );
      return;
    }

    if (details.prompt.name === "consent") {
      const accountId = details.session?.accountId;
      if (accountId === undefined) {
        throw new AppError({
          code: "oidc.interaction_state_invalid",
          title: "Interaction unavailable",
          status: 400,
          detail: "No authenticated session is attached to this interaction.",
        });
      }

      const promptDetails = details.prompt.details as ConsentPromptDetails;
      const clientId = String(details.params.client_id);
      const grant =
        details.grantId === undefined
          ? new provider.Grant({ accountId, clientId })
          : ((await provider.Grant.find(details.grantId)) ?? new provider.Grant({ accountId, clientId }));

      if (promptDetails.missingOIDCScope !== undefined) {
        grant.addOIDCScope(promptDetails.missingOIDCScope);
      }
      if (promptDetails.missingOIDCClaims !== undefined) {
        grant.addOIDCClaims(promptDetails.missingOIDCClaims);
      }
      if (promptDetails.missingResourceScopes !== undefined) {
        for (const [indicator, scopes] of Object.entries(promptDetails.missingResourceScopes)) {
          grant.addResourceScope(indicator, scopes);
        }
      }

      const grantId = await grant.save();
      await provider.interactionFinished(
        request,
        response,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      return;
    }

    throw new AppError({
      code: "oidc.unsupported_prompt",
      title: "Unsupported interaction",
      status: 501,
      detail: `Interaction prompt "${details.prompt.name}" is not supported.`,
    });
  });

  router.post("/:uid/abort", async (request, response) => {
    await provider.interactionFinished(
      request,
      response,
      { error: "access_denied", error_description: "End-user aborted interaction" },
      { mergeWithLastSubmission: false },
    );
  });

  return router;
}
