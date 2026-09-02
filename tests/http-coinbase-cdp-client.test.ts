import { importJWK, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

import { HttpCoinbaseCdpClient } from "../src/modules/offering/infrastructure/http-coinbase-cdp.client.js";

// A throwaway Ed25519 keypair generated solely for this test, in CDP's
// expected 64-byte (32-byte seed + 32-byte raw public key) base64 secret
// format. Not connected to any real Coinbase account.
const apiKeyId = "11111111-1111-4111-8111-111111111111";
const apiKeySecret =
  "MhBYvIZEwowYug+fQFKD35URQmPzSuUHQz0PEWmbWLOaRIqqYxPJmtYfF5olo7aQ1ZNOP6d36YwO4O4lhEz8pQ==";
const publicKeyBase64Url = Buffer.from(apiKeySecret, "base64")
  .subarray(32)
  .toString("base64url");

type FetchLike = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>;

function buildClient(fetch: FetchLike) {
  return new HttpCoinbaseCdpClient({
    baseUrl: "https://api.developer.coinbase.com",
    payHostedUrl: "https://pay.coinbase.com/buy/select-asset",
    apiKeyId,
    apiKeySecret,
    fetch,
  });
}

async function verifyAuthHeader(init: RequestInit): Promise<{ payload: unknown; header: unknown }> {
  const authorization = (init.headers as Record<string, string>).authorization ?? "";
  expect(authorization).toMatch(/^Bearer /);
  const jwt = authorization.replace("Bearer ", "");
  const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKeyBase64Url }, "EdDSA");
  const result = await jwtVerify(jwt, key, { audience: "cdp_service" });
  return { payload: result.payload, header: result.protectedHeader };
}

describe("Coinbase CDP HTTP client", () => {
  it("creates an onramp session token with a correctly signed request", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ token: "session-token-01", channel_id: "channel-01" }, { status: 201 }),
    );
    const client = buildClient(fetch);

    const result = await client.createOnrampSessionToken({
      walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      blockchain: "base",
    });

    expect(result).toEqual({ token: "session-token-01", channelId: "channel-01" });
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.developer.coinbase.com/onramp/v1/token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      addresses: [
        { address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", blockchains: ["base"] },
      ],
    });

    const { payload, header } = await verifyAuthHeader(init);
    expect(payload).toMatchObject({
      sub: apiKeyId,
      iss: "cdp",
      aud: ["cdp_service"],
      uris: ["POST api.developer.coinbase.com/onramp/v1/token"],
    });
    expect(header).toMatchObject({ alg: "EdDSA", kid: apiKeyId, typ: "JWT" });
  });

  it("builds the hosted onramp URL from a session token", () => {
    const client = buildClient(vi.fn());

    const url = client.buildOnrampUrl({
      sessionToken: "session-token-01",
      partnerUserRef: "reservation_01",
      redirectUrl: "https://app.vistablox.eu/reservations/reservation_01",
    });

    expect(url).toBe(
      "https://pay.coinbase.com/buy/select-asset?sessionToken=session-token-01&partnerUserRef=reservation_01&redirectUrl=https%3A%2F%2Fapp.vistablox.eu%2Freservations%2Freservation_01",
    );
  });

  it("lists and normalizes buy transactions for a partner user reference", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        transactions: [
          {
            transaction_id: "txn_01",
            status: "ONRAMP_TRANSACTION_STATUS_SUCCESS",
            wallet_address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
            purchase_currency: "EURC",
            purchase_amount: { currency: "EURC", value: "950.000000" },
            payment_total: { currency: "EUR", value: "1000.00" },
            tx_hash: "0xabc",
            created_at: "2026-09-02T10:00:00.000Z",
            completed_at: "2026-09-02T10:05:00.000Z",
            user_id: "must-not-leak-into-summary",
          },
          {
            transaction_id: "txn_02",
            status: "ONRAMP_TRANSACTION_STATUS_IN_PROGRESS",
            wallet_address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
            purchase_currency: "EURC",
            purchase_amount: { currency: "EURC", value: "0.000000" },
            payment_total: { currency: "EUR", value: "500.00" },
            tx_hash: null,
            created_at: "2026-09-02T11:00:00.000Z",
            completed_at: null,
          },
        ],
        next_page_key: "page-2",
        total_count: 2,
      }),
    );
    const client = buildClient(fetch);

    const result = await client.listBuyTransactions({ partnerUserRef: "reservation_01" });

    expect(result).toEqual({
      transactions: [
        {
          transactionId: "txn_01",
          status: "success",
          walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
          purchaseCurrency: "EURC",
          purchaseAmountValue: "950.000000",
          paymentTotalCurrency: "EUR",
          paymentTotalValue: "1000.00",
          txHash: "0xabc",
          createdAt: new Date("2026-09-02T10:00:00.000Z"),
          completedAt: new Date("2026-09-02T10:05:00.000Z"),
        },
        {
          transactionId: "txn_02",
          status: "in_progress",
          walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
          purchaseCurrency: "EURC",
          purchaseAmountValue: "0.000000",
          paymentTotalCurrency: "EUR",
          paymentTotalValue: "500.00",
          txHash: null,
          createdAt: new Date("2026-09-02T11:00:00.000Z"),
          completedAt: null,
        },
      ],
      nextPageKey: "page-2",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak-into-summary");
    const [url] = fetch.mock.calls[0] as [URL];
    expect(url.toString()).toBe(
      "https://api.developer.coinbase.com/onramp/v1/buy/user/reservation_01/transactions",
    );
  });

  it("paginates buy transactions with page_key", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({ transactions: [], next_page_key: null }),
    );
    const client = buildClient(fetch);

    await client.listBuyTransactions({ partnerUserRef: "reservation_01", pageKey: "page-2" });

    const [url] = fetch.mock.calls[0] as [URL];
    expect(url.toString()).toBe(
      "https://api.developer.coinbase.com/onramp/v1/buy/user/reservation_01/transactions?page_key=page-2",
    );
  });

  it("returns a safe provider error without response content", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("sensitive upstream error", { status: 401 }));
    const client = buildClient(fetch);

    await expect(
      client.createOnrampSessionToken({ walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", blockchain: "base" }),
    ).rejects.toMatchObject({
      code: "offering.coinbase_provider_unavailable",
      message: "The Coinbase CDP onramp provider is temporarily unavailable.",
    });
  });

  it("rejects an unrecognized transaction status rather than passing it through silently", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        transactions: [
          {
            transaction_id: "txn_03",
            status: "ONRAMP_TRANSACTION_STATUS_SOMETHING_NEW",
            wallet_address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
            purchase_currency: "EURC",
            purchase_amount: { currency: "EURC", value: "0.000000" },
            payment_total: { currency: "EUR", value: "0.00" },
            created_at: "2026-09-02T11:00:00.000Z",
          },
        ],
      }),
    );
    const client = buildClient(fetch);

    await expect(client.listBuyTransactions({ partnerUserRef: "reservation_01" })).rejects.toMatchObject({
      code: "offering.coinbase_provider_response_invalid",
    });
  });
});
