import { randomBytes } from "node:crypto";

import { importJWK, importPKCS8, SignJWT } from "jose";
import type { Logger } from "pino";
import { z } from "zod";

import { toChecksumWalletAddress } from "../../../shared/domain/wallet-address.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type {
  CoinbaseCdpClient,
  CreateOnrampSessionTokenResult,
  OnrampTransactionStatus,
  OnrampTransactionSummary,
} from "../application/coinbase-cdp-client.js";

type Fetch = typeof globalThis.fetch;

type CoinbaseCdpOperation = "create_onramp_session_token" | "list_buy_transactions";

/**
 * Stable event names an operator alert rule keys on (with `severity`), the
 * same convention as the wallet-registry alerts. Renaming one breaks the rule.
 */
export const COINBASE_CDP_ALERT_EVENTS = {
  authRejected: "coinbase_cdp.auth_rejected",
  keyInvalid: "coinbase_cdp.key_invalid",
  requestRejected: "coinbase_cdp.request_rejected",
} as const;

/**
 * How a non-2xx CDP response is handled:
 * - `retryable`: 5xx, 408, 429 (and anything else unexpected). A transient
 *   outage; the same request may succeed later.
 * - `auth`: 401/403. Our API key is wrong, revoked or lacks the scope. No
 *   retry will fix it; an operator has to.
 * - `rejected`: any other 4xx. CDP refused this particular request; sending
 *   it again unchanged will not succeed.
 */
export type CoinbaseCdpFailureClass = "retryable" | "auth" | "rejected";

export function classifyCoinbaseCdpStatus(status: number): CoinbaseCdpFailureClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 429) return "retryable";
  if (status >= 400 && status < 500) return "rejected";
  return "retryable";
}

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
      logger?: Pick<Logger, "error" | "warn">;
    },
  ) {}

  public async createOnrampSessionToken(input: {
    walletAddress: string;
    blockchain: string;
  }): Promise<CreateOnrampSessionTokenResult> {
    const response = await this.request("create_onramp_session_token", "POST", "/onramp/v1/token", {
      // The API's canonical form is lowercase; Coinbase is shown EIP-55.
      addresses: [{ address: toChecksumWalletAddress(input.walletAddress), blockchains: [input.blockchain] }],
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
    const response = await this.request("list_buy_transactions", "GET", `${path}${query}`);
    const parsed = listBuyTransactionsResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success) throw invalidProviderResponseError(parsed.error);
    return {
      transactions: parsed.data.transactions.map(toTransactionSummary),
      nextPageKey: parsed.data.next_page_key ?? null,
    };
  }

  private async request(
    operation: CoinbaseCdpOperation,
    method: "GET" | "POST",
    pathWithQuery: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    const url = new URL(pathWithQuery, this.options.baseUrl);
    const [pathOnly] = pathWithQuery.split("?");
    const jwt = await this.signJwt({
      operation,
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
      // The response body is never read: it may echo request data or carry
      // provider internals, and nothing here needs it.
      const cause = new Error(`Coinbase CDP request failed with HTTP ${response.status}`);
      switch (classifyCoinbaseCdpStatus(response.status)) {
        case "auth":
          this.options.logger?.error(
            {
              event: COINBASE_CDP_ALERT_EVENTS.authRejected,
              severity: "error",
              operation,
              http_status: response.status,
            },
            "Coinbase CDP rejected the platform's API credentials; check COINBASE_CDP_API_KEY_ID/SECRET and the key's permissions",
          );
          throw providerAuthRejectedError(cause);
        case "rejected":
          this.options.logger?.warn(
            {
              event: COINBASE_CDP_ALERT_EVENTS.requestRejected,
              severity: "warn",
              operation,
              http_status: response.status,
            },
            "Coinbase CDP rejected the request as invalid",
          );
          throw providerRequestRejectedError(cause);
        case "retryable":
          throw providerUnavailableError(cause);
      }
    }
    return response;
  }

  private async signJwt(input: {
    operation: CoinbaseCdpOperation;
    method: string;
    host: string;
    path: string;
  }): Promise<string> {
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

    this.options.logger?.error(
      { event: COINBASE_CDP_ALERT_EVENTS.keyInvalid, severity: "error", operation: input.operation },
      "COINBASE_CDP_API_KEY_SECRET is neither a PEM EC key nor a base64 Ed25519 key",
    );
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

function providerAuthRejectedError(cause: unknown): AppError {
  return new AppError({
    code: "offering.coinbase_provider_auth_rejected",
    title: "Onramp unavailable",
    status: 500,
    detail: "The onramp provider is misconfigured on our side. Retrying will not help until it is fixed.",
    cause,
  });
}

function providerRequestRejectedError(cause: unknown): AppError {
  return new AppError({
    code: "offering.coinbase_provider_request_rejected",
    title: "Onramp request rejected",
    status: 422,
    detail: "The Coinbase CDP onramp provider rejected this request. Retrying it unchanged will not succeed.",
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
