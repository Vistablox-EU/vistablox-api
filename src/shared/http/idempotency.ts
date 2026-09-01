import { createHash } from "node:crypto";
import type { RequestHandler } from "express";

import type { IdempotencyStore } from "../../infrastructure/idempotency/idempotency-store.js";
import { AppError } from "../errors/app-error.js";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

// AD-147 leaves the retention window as "an implementation default, not
// fixed policy" — long enough to outlive any plausible client retry.
const RETENTION_HOURS = 48;

// AD-057/AD-147: every Idempotency-Key-guarded high-risk write deduplicates
// through this one shared audit.idempotency_keys mechanism. `endpoint` is an
// explicit, stable operation identifier supplied by the mount site — not
// derived from the request path — so it stays stable across route refactors.
export function createIdempotencyMiddleware(
  store: IdempotencyStore,
  endpoint: string,
  clock: () => Date = () => new Date(),
): RequestHandler {
  return (request, response, next) => {
    const idempotencyKey = request.header(IDEMPOTENCY_KEY_HEADER);
    if (idempotencyKey === undefined || idempotencyKey.trim() === "") {
      next(
        new AppError({
          code: "idempotency.key_required",
          title: "Idempotency-Key required",
          status: 400,
          detail: `This operation requires an ${IDEMPOTENCY_KEY_HEADER} header.`,
        }),
      );
      return;
    }

    const requestBodyHash = hashRequestBody(request.body);

    // Whether this key has been seen before must be resolved before the
    // handler runs a high-risk write, so a lookup failure here fails
    // closed (503) rather than risking a duplicate. Once the handler has
    // actually run, the side effect already happened; failing to cache the
    // response at that point must not hide a successful result from the
    // caller, so the save path below fails open instead.
    store
      .find(idempotencyKey, endpoint)
      .catch((error: unknown) => {
        throw new AppError({
          code: "idempotency.store_unavailable",
          title: "Service unavailable",
          status: 503,
          detail: "Could not verify this Idempotency-Key against prior requests.",
          cause: error,
        });
      })
      .then((existing) => {
        if (existing === null) {
          interceptResponse(response, (status, body) => {
            const accountId = response.locals.authContext?.accountId ?? null;
            const now = clock();
            return store.save({
              idempotencyKey,
              endpoint,
              requestBodyHash,
              responseStatus: status,
              responseBody: body,
              accountId,
              createdAt: now,
              expiresAt: new Date(now.getTime() + RETENTION_HOURS * 60 * 60 * 1000),
            });
          });
          next();
          return;
        }

        if (existing.requestBodyHash !== requestBodyHash) {
          throw new AppError({
            code: "idempotency.body_mismatch",
            title: "Duplicate idempotent operation",
            status: 409,
            detail: `This ${IDEMPOTENCY_KEY_HEADER} was already used with a different request body.`,
          });
        }

        response.status(existing.responseStatus).json(existing.responseBody);
      })
      .catch(next);
  };
}

function interceptResponse(
  response: Parameters<RequestHandler>[1],
  onResponse: (status: number, body: unknown) => Promise<unknown>,
): void {
  const originalJson = response.json.bind(response);
  response.json = ((body: unknown) => {
    onResponse(response.statusCode, body)
      .catch((error: unknown) => {
        response.locals.logger?.warn(
          { err: error },
          "idempotency-key store unavailable; response was not cached",
        );
      })
      .finally(() => {
        originalJson(body);
      });
    return response;
  }) as typeof response.json;
}

function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(stableStringify(body)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
