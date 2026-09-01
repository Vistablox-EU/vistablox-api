import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  ListOwnSessionsService,
  RevokeOwnSessionService,
} from "../application/customer-session.service.js";
import { listOwnSessionsResponseSchema, sessionIdParamsSchema } from "./customer-session.schemas.js";

export function createCustomerSessionRouter(
  requireAuthentication: RequestHandler,
  listOwnSessions: ListOwnSessionsService,
  revokeOwnSession: RevokeOwnSessionService,
): Router {
  const router = Router();

  router.get("/", requireAuthentication, async (_request, response) => {
    const context = requireAuthContext(response.locals.authContext);
    const sessions = await listOwnSessions.execute(context.accountId, context.providerSessionId);
    response.setHeader("Cache-Control", "no-store");
    response.json(
      listOwnSessionsResponseSchema.parse({
        data: sessions.map((session) => ({
          session_id: session.sessionId,
          channel: session.channel,
          device_label: session.deviceLabel,
          auth_method_at_login: session.authMethodAtLogin,
          created_at: session.createdAt.toISOString(),
          last_seen_at: session.lastSeenAt.toISOString(),
          status: session.status,
          revocation_reason: session.revocationReason,
          is_current: session.isCurrent,
        })),
      }),
    );
  });

  router.post("/:session_id/revoke", requireAuthentication, async (request, response) => {
    const context = requireAuthContext(response.locals.authContext);
    const params = sessionIdParamsSchema.parse(request.params);
    await revokeOwnSession.execute(context.accountId, params.session_id, request.headers);
    response.status(204).end();
  });

  return router;
}

function requireAuthContext(
  context: { accountId: string; providerSessionId: string } | undefined,
): { accountId: string; providerSessionId: string } {
  if (context === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  return context;
}
