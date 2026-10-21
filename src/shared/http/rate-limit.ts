import { isIP } from "node:net";

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

export function createRateLimiter(
  store: RateLimitStore,
  tier: RateLimitTier,
  subject: (request: Request, response: Response) => string = rateLimitSubject,
): RequestHandler {
  return (request, response, next) => {
    const key = `rate_limit_hint:${tier.name}:${subject(request, response)}`;

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
  const client = normalizeClientIp(request.ip) ?? normalizeClientIp(request.socket.remoteAddress);
  return `ip:${client ?? "unknown"}`;
}

/**
 * The caller's address as one stable bucket key (RATE_LIMITING.md: "a
 * normalized client IP"): an IPv4-mapped IPv6 address becomes plain IPv4, and
 * any other IPv6 address becomes its /64, since a single subscriber normally
 * controls a whole /64 and could otherwise rotate addresses to get a fresh
 * bucket each time. Returns undefined for anything that is not an IP address.
 * That includes a value a caller wrote into X-Forwarded-For and Express
 * handed back as req.ip because TRUST_PROXY counts more proxies than really
 * append an address: the caller then cannot choose its own bucket key, and
 * the connecting address is used instead.
 */
export function normalizeClientIp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const address = raw.split("%")[0] ?? "";
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const hextets = expandIpv6(canonical);
  if (hextets === undefined) return undefined;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
    return `${(h6 ?? 0) >> 8}.${(h6 ?? 0) & 0xff}.${(h7 ?? 0) >> 8}.${(h7 ?? 0) & 0xff}`;
  }
  return `${[h0, h1, h2, h3].map((hextet) => (hextet ?? 0).toString(16)).join(":")}::/64`;
}

// A canonical IPv6 string (lower-case, one "::" at most, no dotted quad, as
// the WHATWG URL serializer produces) as its eight 16-bit groups.
function expandIpv6(canonical: string): number[] | undefined {
  const [head, tail, ...extra] = canonical.split("::");
  if (extra.length > 0 || head === undefined) return undefined;
  const parse = (part: string): number[] => (part === "" ? [] : part.split(":").map((hextet) => Number.parseInt(hextet, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return undefined;
  const groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : undefined;
}

// For the device-auth challenge-issuance routes (no account yet, so the
// default subject above falls back to IP alone): a second, independent
// limiter keyed on the DPoP key requireDpopOnly already verified and set on
// response.locals.dpopJkt. Rotating IPs doesn't reset this one, and rotating
// keys (trivial -- a fresh ES256 keypair per call) doesn't reset the IP one
// -- an attacker has to evade both to keep issuing challenges past the
// limit. Falls back to IP if dpopJkt is somehow unset (defensive only; the
// route this is mounted on always runs requireDpopOnly first).
export function dpopKeyRateLimitSubject(request: Request, response: Response): string {
  const dpopJkt = response.locals.dpopJkt;
  if (typeof dpopJkt === "string") return `dpop_jkt:${dpopJkt}`;
  return rateLimitSubject(request, response);
}
