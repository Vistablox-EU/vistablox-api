import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

import type { IdempotencyStore } from "../../infrastructure/idempotency/idempotency-store.js";
import { AppError } from "../errors/app-error.js";

const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

// AD-147 leaves the retention window as "an implementation default, not
// fixed policy" — long enough to outlive any plausible client retry.
const RETENTION_HOURS = 48;

export interface IdempotencyMiddlewareOptions {
  /**
   * What makes two requests under one key the same request besides their body:
   * typically the authenticated account and the resource ids in the path. The
   * table's key is only (key, endpoint), so without this a key reused by
   * another account, or on another offering or reservation, with an equal body
   * would be answered with the first caller's stored response (their
   * reservation id and onramp URL). The scope is hashed together with the
   * body, so a request from another scope is the same conflict as another
   * body: 409 idempotency.body_mismatch, never a replay. Called after
   * authentication, so `response.locals.authContext` is available.
   */
  scope?: (request: Request, response: Response) => string;
}

// AD-057/AD-147: every Idempotency-Key-guarded high-risk write deduplicates
// through this one shared audit.idempotency_keys mechanism. `endpoint` is an
// explicit, stable operation identifier supplied by the mount site — not
// derived from the request path — so it stays stable across route refactors.
export function createIdempotencyMiddleware(
  store: IdempotencyStore,
  endpoint: string,
  clock: () => Date = () => new Date(),
  options: IdempotencyMiddlewareOptions = {},
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

    const requestBodyHash = hashRequest(request.body, options.scope?.(request, response));

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
          interceptResponse(response, async (status, body) => {
            // A 5xx is a server-side failure (a dependency outage, a crash),
            // not an outcome of the client's request. Persisting it would
            // replay that failure for the whole retention window and block
            // the client's same-key retry (#122), so no row is written and a
            // retry with this key runs the handler again. 2xx and 4xx are
            // final outcomes and stay cached.
            if (status >= 500) return;
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
            detail: `This ${IDEMPOTENCY_KEY_HEADER} was already used for a different request.`,
          });
        }

        // A stored answer can carry a payment URL; the handler's own
        // Cache-Control is not part of what is stored, so it is set again here.
        response.setHeader("Cache-Control", "no-store");
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

function hashRequest(body: unknown, scope: string | undefined): string {
  const fingerprint = scope === undefined ? stableStringify(body) : stableStringify({ body, scope });
  return createHash("sha256").update(fingerprint).digest("hex");
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
  return JSON.stringify(value) ?? "undefined";
}
