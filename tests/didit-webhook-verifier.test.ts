import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalize,
  DiditWebhookVerifier,
} from "../src/modules/identity/infrastructure/didit-webhook-verifier.js";

const secret = "didit-webhook-secret-for-tests";
const now = new Date("2026-09-01T12:00:00.000Z");
const timestamp = Math.floor(now.getTime() / 1_000);

function sign(body: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(canonicalize(body)), "utf8")
    .digest("hex");
}

describe("Didit webhook verification", () => {
  it("accepts recursively sorted Unicode-preserving V2 signatures", () => {
    const body = {
      timestamp,
      vendor_data: "acct_é",
      nested: { z: 2, a: [{ y: true, b: "č" }] },
      event_id: "c2237bc6-a76c-4933-b329-6c81843b45c7",
    };

    expect(() =>
      new DiditWebhookVerifier(secret, () => now).verify({
        body,
        signature: sign(body),
        timestamp: String(timestamp),
      }),
    ).not.toThrow();
  });

  it.each([
    { name: "stale", headerTimestamp: String(timestamp - 301), mutate: false },
    { name: "modified header", headerTimestamp: String(timestamp + 1), mutate: false },
    { name: "tampered body", headerTimestamp: String(timestamp), mutate: true },
  ])("rejects $name webhook attempts", ({ headerTimestamp, mutate }) => {
    const original = { timestamp, status: "Approved" };
    const body = mutate ? { ...original, status: "Declined" } : original;

    expect(() =>
      new DiditWebhookVerifier(secret, () => now).verify({
        body,
        signature: sign(original),
        timestamp: headerTimestamp,
      }),
    ).toThrowError(expect.objectContaining({ code: "identity.didit_webhook_invalid" }));
  });
});
