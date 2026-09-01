import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";

export class DiditWebhookVerifier {
  public constructor(
    private readonly secret: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public verify(input: {
    body: unknown;
    signature: string | undefined;
    timestamp: string | undefined;
  }): void {
    const timestamp = parseTimestamp(input.timestamp);
    if (
      timestamp === null ||
      Math.abs(Math.floor(this.clock().getTime() / 1_000) - timestamp) > 300 ||
      readBodyTimestamp(input.body) !== timestamp
    ) {
      throw invalidWebhookError();
    }
    if (input.signature === undefined || !/^[a-fA-F0-9]{64}$/.test(input.signature)) {
      throw invalidWebhookError();
    }
    const expected = createHmac("sha256", this.secret)
      .update(JSON.stringify(canonicalize(input.body)), "utf8")
      .digest("hex");
    const received = Buffer.from(input.signature.toLowerCase(), "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (
      received.length !== expectedBuffer.length ||
      !timingSafeEqual(received, expectedBuffer)
    ) {
      throw invalidWebhookError();
    }
  }
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined || !/^\d{10}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readBodyTimestamp(body: unknown): number | null {
  if (typeof body !== "object" || body === null || !("timestamp" in body)) return null;
  const timestamp = (body as Record<string, unknown>).timestamp;
  return typeof timestamp === "number" && Number.isSafeInteger(timestamp)
    ? timestamp
    : null;
}

function invalidWebhookError(): AppError {
  return new AppError({
    code: "identity.didit_webhook_invalid",
    title: "Webhook authentication failed",
    status: 401,
    detail: "The webhook signature or timestamp is invalid.",
  });
}
