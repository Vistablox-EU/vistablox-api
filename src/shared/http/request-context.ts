import type { RequestHandler } from "express";
import { ulid } from "ulid";

const traceHeader = "x-trace-id";
const authEventHeader = "x-vistablox-auth-event-id";

export const requestContext: RequestHandler = (request, response, next) => {
  const inboundTraceId = request.header(traceHeader);
  const traceId = inboundTraceId?.trim() || `req_${ulid()}`;

  request.headers[traceHeader] = traceId;
  request.headers[authEventHeader] = `auth_evt_${ulid()}`;
  response.locals.traceId = traceId;
  response.setHeader(traceHeader, traceId);
  next();
};
