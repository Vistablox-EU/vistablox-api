import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

import { AppError } from "../errors/app-error.js";
import { translateBodyParserError } from "./body-parser-error.js";
import { errorResponseSchema, type ErrorResponse } from "./error-schema.js";

export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const rejectedBody = translateBodyParserError(error);
  const normalized = rejectedBody?.error ?? normalizeError(error);
  const traceId = String(response.locals.traceId ?? "unknown");

  const payload: ErrorResponse = {
    type: normalized.type,
    code: normalized.code,
    title: normalized.title,
    status: normalized.status,
    detail: normalized.message,
    trace_id: traceId,
    ...(normalized.fieldErrors === undefined ? {} : { field_errors: normalized.fieldErrors }),
  };

  if (rejectedBody !== undefined) {
    // The client's mistake, not ours. Log what identifies the failure but not
    // the parser's error object, which holds the request body.
    response.locals.logger?.warn(
      {
        trace_id: traceId,
        status: normalized.status,
        code: normalized.code,
        parser_error: rejectedBody.parserError,
      },
      "request body rejected",
    );
  } else if (normalized.status >= 500) {
    response.locals.logger?.error({ err: error, trace_id: traceId }, "request failed");
  }

  response.status(normalized.status).json(errorResponseSchema.parse(payload));
};

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ZodError) {
    return new AppError({
      code: "validation.invalid_field",
      title: "Request validation failed",
      status: 422,
      detail: "One or more fields did not pass validation.",
      fieldErrors: error.issues.map((issue) => ({
        field: issue.path.join(".") || "request",
        code: issue.code,
        message: issue.message,
      })),
      cause: error,
    });
  }

  return new AppError({
    code: "internal.unexpected",
    title: "Internal server error",
    status: 500,
    detail: "An unexpected error occurred.",
    cause: error,
  });
}
