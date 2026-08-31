import type { RequestHandler } from "express";

import { AppError } from "../errors/app-error.js";

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(
    new AppError({
      code: "resource.not_found",
      title: "Resource not found",
      status: 404,
      detail: `No route exists for ${request.method} ${request.path}.`,
    }),
  );
};
