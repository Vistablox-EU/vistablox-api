import type { RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";

const CREDENTIAL_EMAIL_PATH = /^\/api\/auth\/(?:sign-in|sign-up)\/email\/?$/;
const EMAIL_OTP_PATH = /^\/api\/auth\/(?:email-otp|sign-in\/email-otp)(?:\/|$)/;
// Passkey replacement only ever happens via account recovery and staff
// recovery's bootstrap flow (issuePasskeyBootstrap -> registration's
// afterVerification deleting the prior credential directly through the
// adapter) -- the passkey plugin's own generic delete-passkey endpoint is a
// second, unguarded path to the same destructive action for any signed-in
// user, bypassing that flow entirely. update-passkey (rename only) stays
// open; there's no equivalent risk in renaming a label.
const PASSKEY_DELETE_PATH = /^\/api\/auth\/passkey\/delete-passkey\/?$/;

/** Keeps disabled credential/email-code endpoints and open passkey deletion off the public wire. */
export const rejectDisabledAuthRoutes: RequestHandler = (request, _response, next) => {
  const path = request.path.toLowerCase();
  if (
    path.includes("password") ||
    CREDENTIAL_EMAIL_PATH.test(path) ||
    EMAIL_OTP_PATH.test(path) ||
    PASSKEY_DELETE_PATH.test(path)
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
