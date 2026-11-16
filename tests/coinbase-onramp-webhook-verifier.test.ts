import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CoinbaseOnrampWebhookVerifier } from "../src/modules/offering/infrastructure/coinbase-onramp-webhook-verifier.js";

const secret = "coinbase-webhook-secret-for-tests";
const now = new Date("2026-09-01T12:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);
const rawBody = Buffer.from(
  '{"eventType":"onramp.transaction.success","transactionId":"tx_1","partnerUserRef":"reservation_01"}',
  "utf8",
);

function v0(body: Buffer, at: number, key = secret): string {
  return createHmac("sha256", key).update(`${at}.`).update(body).digest("hex");
}

function header(signature: string, at = timestamp): string {
  return `t=${at},v0=${signature},h=content-type x-event-id x-event-type,v1=${"ab".repeat(32)}`;
}

function verify(signatureHeader: string | undefined, body = rawBody): void {
  new CoinbaseOnrampWebhookVerifier(secret, () => now).verify({ rawBody: body, signatureHeader });
}

const invalid = expect.objectContaining({ code: "offering.coinbase_webhook_invalid", status: 401 });

describe("Coinbase onramp webhook verification", () => {
  it("accepts a v0 signature over the timestamp and raw body", () => {
    expect(() => verify(header(v0(rawBody, timestamp)))).not.toThrow();
  });

  it("accepts an uppercase hex signature and a timestamp just inside the window", () => {
    const at = timestamp - 300;
    expect(() => verify(header(v0(rawBody, at).toUpperCase(), at))).not.toThrow();
  });

  it.each([
    { name: "tampered body", signatureHeader: header(v0(rawBody, timestamp)), body: Buffer.from(rawBody.toString().replace("tx_1", "tx_2")) },
    { name: "wrong secret", signatureHeader: header(v0(rawBody, timestamp, "other-secret")), body: rawBody },
    { name: "stale timestamp", signatureHeader: header(v0(rawBody, timestamp - 301), timestamp - 301), body: rawBody },
    { name: "future timestamp", signatureHeader: header(v0(rawBody, timestamp + 301), timestamp + 301), body: rawBody },
    { name: "timestamp swapped after signing", signatureHeader: header(v0(rawBody, timestamp), timestamp + 1), body: rawBody },
    { name: "missing header", signatureHeader: undefined, body: rawBody },
    { name: "empty header", signatureHeader: "", body: rawBody },
    { name: "no v0", signatureHeader: `t=${timestamp},v1=${v0(rawBody, timestamp)}`, body: rawBody },
    { name: "no timestamp", signatureHeader: `v0=${v0(rawBody, timestamp)}`, body: rawBody },
    { name: "duplicate timestamp", signatureHeader: `t=${timestamp},t=${timestamp + 1},v0=${v0(rawBody, timestamp)}`, body: rawBody },
    { name: "truncated signature", signatureHeader: header(v0(rawBody, timestamp).slice(0, 62)), body: rawBody },
    { name: "non-hex signature", signatureHeader: header("z".repeat(64)), body: rawBody },
  ])("rejects $name", ({ signatureHeader, body }) => {
    expect(() => verify(signatureHeader, body)).toThrowError(invalid);
  });

  it("does not accept the v1 value in place of v0", () => {
    const signatureHeader = `t=${timestamp},v0=${"00".repeat(32)},v1=${v0(rawBody, timestamp)}`;
    expect(() => verify(signatureHeader)).toThrowError(invalid);
  });
});
