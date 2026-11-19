import type { Response } from "express";
import type { z } from "zod";

import { AppError } from "../errors/app-error.js";

/**
 * Sends `payload` as the JSON response after checking it against the route's
 * response schema.
 *
 * A payload that does not match is the server's bug, not the client's: it
 * becomes a 500 `internal.response_invalid`. A bare `schema.parse(...)` throws
 * a ZodError, which the error handler reads as request validation and answers
 * with a 422 `validation.invalid_field` — a client error the caller treats as
 * final and the idempotency middleware stores, for a failure no retry of the
 * request body could fix (#72). The 500 is logged by the error handler with
 * its trace_id; its cause names the failing paths and issue codes and never
 * the values, which can be customer data.
 */
export function sendValidated<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  payload: unknown,
  status?: number,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw responseInvalidError(parsed.error);
  if (status !== undefined) response.status(status);
  response.json(parsed.data);
}

function responseInvalidError(error: z.ZodError): AppError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "response",
    code: issue.code,
  }));
  const summary = issues.map((issue) => `${issue.path} (${issue.code})`).join(", ");
  return new AppError({
    code: "internal.response_invalid",
    title: "Internal server error",
    status: 500,
    detail: "The server produced a response that does not match its schema.",
    cause: Object.assign(new Error(`response schema mismatch at ${summary}`), { issues }),
  });
}
