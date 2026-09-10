import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  ListOwnSessionsService,
  RevokeAllOwnSessionsService,
  RevokeDeviceSessionsService,
  RevokeOwnSessionService,
} from "../application/customer-session.service.js";
import {
  dpopKeyParamsSchema,
  listOwnSessionsResponseSchema,
  revokeDeviceResponseSchema,
  sessionIdParamsSchema,
} from "./customer-session.schemas.js";

export function createCustomerSessionRouter(
  requireAuthentication: RequestHandler,
  listOwnSessions: ListOwnSessionsService,
  revokeOwnSession: RevokeOwnSessionService,
  revokeAllOwnSessions: RevokeAllOwnSessionsService,
  revokeDeviceSessions?: RevokeDeviceSessionsService,
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

  router.post("/revoke-all", requireAuthentication, async (request, response) => {
    requireAuthContext(response.locals.authContext);
    await revokeAllOwnSessions.execute(request.headers);
    response.status(204).end();
  });

  router.post("/:session_id/revoke", requireAuthentication, async (request, response) => {
    const context = requireAuthContext(response.locals.authContext);
    const params = sessionIdParamsSchema.parse(request.params);
    await revokeOwnSession.execute(context.accountId, params.session_id, request.headers);
    response.status(204).end();
  });

  if (revokeDeviceSessions !== undefined) {
    router.post("/devices/:jkt/revoke", requireAuthentication, async (request, response) => {
      requireAuthContext(response.locals.authContext);
      const params = dpopKeyParamsSchema.parse(request.params);
      const result = await revokeDeviceSessions.execute(params.jkt, request.headers);
      response.setHeader("Cache-Control", "no-store");
      response.json(
        revokeDeviceResponseSchema.parse({ data: { revoked_count: result.revokedCount } }),
      );
    });
  }

  return router;
}

function requireAuthContext(
  context: Express.Locals["authContext"],
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
