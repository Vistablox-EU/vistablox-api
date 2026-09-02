import { randomBytes } from "node:crypto";

import { importJWK, importPKCS8, SignJWT } from "jose";
import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CoinbaseCdpClient,
  CreateOnrampSessionTokenResult,
  OnrampTransactionStatus,
  OnrampTransactionSummary,
} from "../application/coinbase-cdp-client.js";

type Fetch = typeof globalThis.fetch;

const amountSchema = z.object({ currency: z.string(), value: z.string() });

const createTokenResponseSchema = z.object({
  token: z.string().min(1),
  channel_id: z.string().min(1),
});

const onrampTransactionStatuses: Record<string, OnrampTransactionStatus> = {
  ONRAMP_TRANSACTION_STATUS_CREATED: "created",
  ONRAMP_TRANSACTION_STATUS_IN_PROGRESS: "in_progress",
  ONRAMP_TRANSACTION_STATUS_SUCCESS: "success",
  ONRAMP_TRANSACTION_STATUS_FAILED: "failed",
};

const onrampTransactionSchema = z
  .object({
    transaction_id: z.string().min(1),
    status: z.string(),
    wallet_address: z.string().min(1),
    purchase_currency: z.string().min(1),
    purchase_amount: amountSchema,
    payment_total: amountSchema,
    tx_hash: z.string().nullish(),
    created_at: z.iso.datetime(),
    completed_at: z.iso.datetime().nullish(),
  })
  .passthrough();

const listBuyTransactionsResponseSchema = z.object({
  transactions: z.array(onrampTransactionSchema),
  next_page_key: z.string().nullish(),
  total_count: z.number().int().min(0).optional(),
});

/**
 * Onramp/offramp REST client (AD-255). Auth follows CDP's standard JWT
 * bearer scheme, verified directly against @coinbase/cdp-sdk's own
 * auth/utils/jwt.ts rather than assumed: EdDSA (Ed25519, 64-byte base64
 * secret) or ES256 (PEM EC key) auto-detected from the configured secret's
 * shape, header {alg, kid: apiKeyId, typ: "JWT", nonce}, claims {sub:
 * apiKeyId, iss: "cdp", aud, uris: ["METHOD host/path"]}, 120s expiry.
 */
export class HttpCoinbaseCdpClient implements CoinbaseCdpClient {
  public constructor(
    private readonly options: {
      baseUrl: string;
      payHostedUrl: string;
      apiKeyId: string;
      apiKeySecret: string;
      audience?: string[];
      fetch?: Fetch;
      timeoutMs?: number;
    },
  ) {}

  public async createOnrampSessionToken(input: {
    walletAddress: string;
    blockchain: string;
  }): Promise<CreateOnrampSessionTokenResult> {
    const response = await this.request("POST", "/onramp/v1/token", {
      addresses: [{ address: input.walletAddress, blockchains: [input.blockchain] }],
    });
    const parsed = createTokenResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success) throw invalidProviderResponseError(parsed.error);
    return { token: parsed.data.token, channelId: parsed.data.channel_id };
  }

  public buildOnrampUrl(input: {
    sessionToken: string;
    partnerUserRef: string;
    redirectUrl: string;
  }): string {
    const url = new URL(this.options.payHostedUrl);
    url.searchParams.set("sessionToken", input.sessionToken);
    url.searchParams.set("partnerUserRef", input.partnerUserRef);
    url.searchParams.set("redirectUrl", input.redirectUrl);
    return url.toString();
  }

  public async listBuyTransactions(input: {
    partnerUserRef: string;
    pageKey?: string;
  }): Promise<{ transactions: OnrampTransactionSummary[]; nextPageKey: string | null }> {
    const path = `/onramp/v1/buy/user/${encodeURIComponent(input.partnerUserRef)}/transactions`;
    const query = input.pageKey === undefined ? "" : `?page_key=${encodeURIComponent(input.pageKey)}`;
    const response = await this.request("GET", `${path}${query}`);
    const parsed = listBuyTransactionsResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success) throw invalidProviderResponseError(parsed.error);
    return {
      transactions: parsed.data.transactions.map(toTransactionSummary),
      nextPageKey: parsed.data.next_page_key ?? null,
    };
  }

  private async request(
    method: "GET" | "POST",
    pathWithQuery: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    const url = new URL(pathWithQuery, this.options.baseUrl);
    const [pathOnly] = pathWithQuery.split("?");
    const jwt = await this.signJwt({
      method,
      host: url.host,
      path: pathOnly ?? pathWithQuery,
    });
    let response: Response;
    try {
      response = await fetchImplementation(url, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw providerUnavailableError(error);
    }
    if (!response.ok) {
      throw providerUnavailableError(
        new Error(`Coinbase CDP request failed with HTTP ${response.status}`),
      );
    }
    return response;
  }

  private async signJwt(input: { method: string; host: string; path: string }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString("hex");
    const claims = {
      sub: this.options.apiKeyId,
      iss: "cdp",
      aud: this.options.audience ?? ["cdp_service"],
      uris: [`${input.method} ${input.host}${input.path}`],
    };

    const ecKey = await tryImportEcKey(this.options.apiKeySecret);
    if (ecKey !== null) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: this.options.apiKeyId, typ: "JWT", nonce })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 120)
        .sign(ecKey);
    }

    const edKey = await tryImportEd25519Key(this.options.apiKeySecret);
    if (edKey !== null) {
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "EdDSA", kid: this.options.apiKeyId, typ: "JWT", nonce })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 120)
        .sign(edKey);
    }

    throw new AppError({
      code: "offering.coinbase_provider_key_invalid",
      title: "Onramp unavailable",
      status: 500,
      detail: "The configured Coinbase CDP API key secret is neither a PEM EC key nor a base64 Ed25519 key.",
    });
  }
}

async function tryImportEcKey(secret: string) {
  try {
    return await importPKCS8(secret, "ES256");
  } catch {
    return null;
  }
}

async function tryImportEd25519Key(secret: string) {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(secret, "base64");
  } catch {
    return null;
  }
  if (decoded.length !== 64) return null;
  const seed = decoded.subarray(0, 32);
  const publicKey = decoded.subarray(32);
  try {
    return await importJWK(
      { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: publicKey.toString("base64url") },
      "EdDSA",
    );
  } catch {
    return null;
  }
}

function toTransactionSummary(
  transaction: z.infer<typeof onrampTransactionSchema>,
): OnrampTransactionSummary {
  const status = onrampTransactionStatuses[transaction.status];
  if (status === undefined) {
    throw invalidProviderResponseError(new Error(`Unknown onramp transaction status: ${transaction.status}`));
  }
  return {
    transactionId: transaction.transaction_id,
    status,
    walletAddress: transaction.wallet_address,
    purchaseCurrency: transaction.purchase_currency,
    purchaseAmountValue: transaction.purchase_amount.value,
    paymentTotalCurrency: transaction.payment_total.currency,
    paymentTotalValue: transaction.payment_total.value,
    txHash: transaction.tx_hash ?? null,
    createdAt: new Date(transaction.created_at),
    completedAt: transaction.completed_at === null || transaction.completed_at === undefined
      ? null
      : new Date(transaction.completed_at),
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw invalidProviderResponseError(error);
  }
}

function providerUnavailableError(cause: unknown): AppError {
  return new AppError({
    code: "offering.coinbase_provider_unavailable",
    title: "Onramp unavailable",
    status: 503,
    detail: "The Coinbase CDP onramp provider is temporarily unavailable.",
    cause,
  });
}

function invalidProviderResponseError(cause?: unknown): AppError {
  return new AppError({
    code: "offering.coinbase_provider_response_invalid",
    title: "Onramp unavailable",
    status: 502,
    detail: "The Coinbase CDP onramp provider returned an invalid response.",
    cause,
  });
}
