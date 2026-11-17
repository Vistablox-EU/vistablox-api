import { createHmac, timingSafeEqual } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";

const MAX_AGE_SECONDS = 300;

/**
 * Coinbase CDP webhook signature check
 * (docs.cdp.coinbase.com/webhooks/verify-signatures). The
 * `X-Webhook-Signature` header is `t=<unix s>,v0=<hex>,h=<names>,v1=<hex>`.
 * This verifies `v0 = HMAC-SHA256(secret, "{t}.{rawBody}")`, the variant CDP
 * recommends unless headers need binding, and rejects any `t` more than five
 * minutes from now in either direction to block replays. The body must be the
 * exact raw bytes received: re-serialised JSON would not match.
 * `X-Hook0-Signature` is CDP's deprecated duplicate of the same value and is
 * only read when the current header is absent.
 *
 * Re-checked on 2026-11-17, when the webhook was rebuilt on main (AD-289),
 * against that page as published: header names, the `t`/`v0`/`h`/`v1` shape,
 * `v0` over `{t}.{rawBody}`, the recommended 5-minute maximum age and the
 * constant-time comparison match this code, and the tests build their headers
 * from that description. The page's example passes the subscription's secret
 * to createHmac as a plain string, as this code does, but says nothing about
 * decoding it. Its sample function compares only `v1` while its tip says `v0`
 * is enough; this code checks `v0`. None of this has been exercised by a real
 * signed delivery yet; the first one, on staging, settles it.
 */
export class CoinbaseOnrampWebhookVerifier {
  public constructor(
    private readonly secret: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public verify(input: { rawBody: Buffer; signatureHeader: string | undefined }): void {
    const parsed = parseSignatureHeader(input.signatureHeader);
    if (parsed === null) throw invalidWebhookError();
    if (Math.abs(Math.floor(this.clock().getTime() / 1_000) - parsed.timestamp) > MAX_AGE_SECONDS) {
      throw invalidWebhookError();
    }
    const expected = createHmac("sha256", this.secret)
      .update(`${parsed.timestamp}.`, "utf8")
      .update(input.rawBody)
      .digest();
    const matches = parsed.v0.some((candidate) => {
      const received = Buffer.from(candidate, "hex");
      return received.length === expected.length && timingSafeEqual(received, expected);
    });
    if (!matches) throw invalidWebhookError();
  }
}

function parseSignatureHeader(
  header: string | undefined,
): { timestamp: number; v0: string[] } | null {
  if (header === undefined || header.length > 2_048) return null;
  let timestamp: number | null = null;
  const v0: string[] = [];
  for (const element of header.split(",")) {
    const separator = element.indexOf("=");
    if (separator <= 0) continue;
    const key = element.slice(0, separator).trim();
    const value = element.slice(separator + 1).trim();
    if (key === "t") {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v0" && /^[a-fA-F0-9]{64}$/.test(value)) {
      v0.push(value.toLowerCase());
    }
  }
  if (timestamp === null || v0.length === 0) return null;
  return { timestamp, v0 };
}

function invalidWebhookError(): AppError {
  return new AppError({
    code: "offering.coinbase_webhook_invalid",
    title: "Webhook authentication failed",
    status: 401,
    detail: "The webhook signature or timestamp is invalid.",
  });
}
