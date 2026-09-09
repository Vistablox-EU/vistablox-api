import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import { canonicalize } from "./didit-webhook-verifier.js";

// Signs/verifies vistablox-api -> vistablox-kyc internal requests. Same
// shape of protection as DiditWebhookVerifier (HMAC over a canonicalized
// payload plus a bounded timestamp window, compared with timingSafeEqual)
// rather than a bare shared-secret header: a bare secret is a replayable
// bearer credential the moment it's observed once (a stray log line, a
// debugging session), where a signed request is only valid for the one
// request it was computed for. Deliberately its own header names
// (X-Internal-Timestamp/X-Internal-Signature), never DiditWebhookVerifier's
// X-Signature-V2/X-Timestamp, so nothing conflates "a header Didit sent us"
// with "a header we invented for our own internal calls." A narrower window
// than Didit's five minutes (60s, not 300s): this is two same-network
// processes with negligible latency, not a third party's webhook that might
// legitimately retry over minutes.
const WINDOW_SECONDS = 60;

function canonicalRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  body: unknown;
}): string {
  const bodyForSigning =
    input.body === undefined ? "" : JSON.stringify(canonicalize(input.body));
  return `${input.method.toUpperCase()}\n${input.path}\n${input.timestamp}\n${bodyForSigning}`;
}

export function signInternalRequest(input: {
  secret: string;
  method: string;
  path: string;
  body?: unknown;
  now?: Date;
}): { signature: string; timestamp: string } {
  const timestamp = String(Math.floor((input.now ?? new Date()).getTime() / 1_000));
  const signature = createHmac("sha256", input.secret)
    .update(
      canonicalRequest({ method: input.method, path: input.path, timestamp, body: input.body }),
      "utf8",
    )
    .digest("hex");
  return { signature, timestamp };
}

export class InternalApiSignatureVerifier {
  public constructor(
    private readonly secret: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public verify(input: {
    method: string;
    path: string;
    body: unknown;
    signature: string | undefined;
    timestamp: string | undefined;
  }): void {
    const timestamp = parseTimestamp(input.timestamp);
    if (
      timestamp === null ||
      Math.abs(Math.floor(this.clock().getTime() / 1_000) - timestamp) > WINDOW_SECONDS
    ) {
      throw invalidInternalRequestError();
    }
    if (input.signature === undefined || !/^[a-fA-F0-9]{64}$/.test(input.signature)) {
      throw invalidInternalRequestError();
    }
    const expected = createHmac("sha256", this.secret)
      .update(
        canonicalRequest({
          method: input.method,
          path: input.path,
          timestamp: String(timestamp),
          body: input.body,
        }),
        "utf8",
      )
      .digest("hex");
    const received = Buffer.from(input.signature.toLowerCase(), "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (
      received.length !== expectedBuffer.length ||
      !timingSafeEqual(received, expectedBuffer)
    ) {
      throw invalidInternalRequestError();
    }
  }
}

function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined || !/^\d{10}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function invalidInternalRequestError(): AppError {
  return new AppError({
    code: "identity.internal_kyc_request_invalid",
    title: "Internal request authentication failed",
    status: 401,
    detail: "The internal request signature or timestamp is invalid.",
  });
}
