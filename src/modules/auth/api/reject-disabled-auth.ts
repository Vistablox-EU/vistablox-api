import type { RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";

const CREDENTIAL_EMAIL_PATH = /^\/api\/auth\/(?:sign-in|sign-up)\/email\/?$/;
const EMAIL_OTP_PATH = /^\/api\/auth\/(?:email-otp|sign-in\/email-otp)(?:\/|$)/;

/** Keeps disabled credential and email-code endpoints off the public wire. */
export const rejectDisabledAuthRoutes: RequestHandler = (request, _response, next) => {
  const path = request.path.toLowerCase();
  if (
    path.includes("password") ||
    CREDENTIAL_EMAIL_PATH.test(path) ||
    EMAIL_OTP_PATH.test(path)
  ) {
    next(
      new AppError({
        code: "resource.not_found",
        title: "Resource not found",
        status: 404,
        detail: "The requested resource does not exist.",
      }),
    );
    return;
  }
  next();
};
