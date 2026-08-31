import type { RequestHandler } from "express";
import { ulid } from "ulid";

const traceHeader = "x-trace-id";

export const requestContext: RequestHandler = (request, response, next) => {
  const inboundTraceId = request.header(traceHeader);
  const traceId = inboundTraceId?.trim() || `req_${ulid()}`;

  response.locals.traceId = traceId;
  response.setHeader(traceHeader, traceId);
  next();
};
