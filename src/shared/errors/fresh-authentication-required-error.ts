import { AppError } from "./app-error.js";

// The one response for "sign in again on this device first". It is shared
// response vocabulary only: what counts as fresh stays in
// src/modules/auth/domain/fresh-authentication.ts, and a caller outside auth
// only ever sees a boolean computed there. The /v1 middleware and the wallet
// service both raise it, so the envelope (code, title, status, detail) cannot
// drift between them.
export function freshAuthenticationRequiredError(): AppError {
  return new AppError({
    code: "authentication.fresh_auth_required",
    title: "Fresh authentication required",
    status: 403,
    detail: "Sign in again on this device before continuing.",
  });
}
