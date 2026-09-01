import type { Request, RequestHandler, Response } from "express";

import type { RateLimitStore } from "../../infrastructure/rate-limit/rate-limit-store.js";
import { AppError } from "../errors/app-error.js";

export interface RateLimitTier {
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

// RATE_LIMITING.md fixes the architecture (Redis-backed, two tiers, keyed by
// account or IP) but leaves numeric thresholds as a tuning task; these are a
// deliberately generous starting point for real traffic to calibrate against.
export const BASELINE_RATE_LIMIT: RateLimitTier = {
  name: "baseline",
  limit: 300,
  windowSeconds: 60,
};

export const TIGHTENED_RATE_LIMIT: RateLimitTier = {
  name: "tightened",
  limit: 10,
  windowSeconds: 60,
};

export function createRateLimiter(store: RateLimitStore, tier: RateLimitTier): RequestHandler {
  return (request, response, next) => {
    const key = `rate_limit_hint:${tier.name}:${rateLimitSubject(request, response)}`;

    store
      .increment(key, tier.windowSeconds)
      .then((count) => {
        if (count > tier.limit) {
          response.setHeader("Retry-After", String(tier.windowSeconds));
          next(
            new AppError({
              code: "rate_limit.exceeded",
              title: "Too many requests",
              status: 429,
              detail: "Too many requests. Please slow down and try again shortly.",
            }),
          );
          return;
        }
        next();
      })
      .catch((error: unknown) => {
        // A rate-limit store outage must degrade performance, not correctness
        // (CACHING_STRATEGY.md) — fail open rather than block all traffic.
        response.locals.logger?.warn(
          { err: error },
          "rate limit store unavailable; allowing request",
        );
        next();
      });
  };
}

// account_id once authenticated (set by requireAuthentication before this
// middleware runs), otherwise the caller's IP — matching RATE_LIMITING.md.
function rateLimitSubject(request: Request, response: Response): string {
  const accountId = response.locals.authContext?.accountId;
  if (accountId !== undefined) return `account:${accountId}`;
  return `ip:${request.ip ?? request.socket.remoteAddress ?? "unknown"}`;
}
