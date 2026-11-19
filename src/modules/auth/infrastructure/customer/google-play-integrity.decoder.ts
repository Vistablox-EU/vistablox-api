import { importPKCS8, SignJWT } from "jose";

import {
  PlayIntegrityDecodeError,
  type PlayIntegrityDecodeStage,
  type PlayIntegrityVerdictDecoder,
} from "../../application/customer/android-attestation-verifier.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";

/**
 * How long each of the decoder's two Google calls (token exchange, decode)
 * may take, response body included. Same budget as the revocation-list fetch
 * and the Didit and Coinbase clients. A decode needs one call while the
 * access token is cached and two when it is not, so enrolment waits at most
 * twice this on Google -- well inside the 60 s a consumed enrolment challenge
 * stays usable.
 */
export const PLAY_INTEGRITY_REQUEST_TIMEOUT_MS = 5_000;

/**
 * A cached access token is dropped this long before the expiry Google states,
 * so a token never expires between being picked from the cache and being
 * checked by Google.
 */
export const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;

// Google's API returns certificateSha256Digest as base64 (Node's "base64"
// decoder also accepts the base64url variant, so either form Google
// actually uses works here) -- verifyPlayIntegrityToken compares against
// ANDROID_ATTESTATION_CERT_DIGESTS, which is hex, the same allowlist
// key-attestation uses. Passed through unconverted, this comparison could
// never match.
export function base64DigestToHex(base64Digest: string): string {
  return Buffer.from(base64Digest, "base64").toString("hex");
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface TokenPayloadExternal {
  requestDetails?: { requestHash?: string };
  appIntegrity?: { appRecognitionVerdict?: string; certificateSha256Digest?: string[] };
  deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
}

/** Injectable for tests; production uses the defaults. */
export interface GooglePlayIntegrityDecoderOptions {
  /** Defaults to the global `fetch`, looked up per call. */
  fetch?: typeof fetch;
  /** Per-call budget; defaults to PLAY_INTEGRITY_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Epoch milliseconds; defaults to Date.now. Drives the token cache only. */
  now?: () => number;
}

interface CachedAccessToken {
  value: string;
  /** Epoch ms, already reduced by ACCESS_TOKEN_EXPIRY_MARGIN_MS. */
  usableUntil: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decodes a Play Integrity standard-request token via Google's REST API,
 * authenticating as the configured service account (decode-only role --
 * PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON, base64). Untested against the real
 * API as of this PR: PLAY_INTEGRITY_POLICY=disabled (no Play Console
 * project yet) means this path isn't live on staging -- confirm against a
 * real token once the account exists.
 *
 * Both Google calls are bounded (PLAY_INTEGRITY_REQUEST_TIMEOUT_MS), the
 * access token is cached until shortly before the expiry Google states, and
 * every failure is a PlayIntegrityDecodeError that names its class.
 */
export class GooglePlayIntegrityDecoder implements PlayIntegrityVerdictDecoder {
  private readonly serviceAccount: ServiceAccountKey;
  private cachedAccessToken: CachedAccessToken | undefined;
  // Concurrent enrolments with no usable cached token share one exchange
  // instead of each signing a JWT and calling Google's token endpoint.
  private accessTokenInFlight: Promise<string> | undefined;

  public constructor(
    serviceAccountJsonBase64: string,
    private readonly cloudProjectNumber: string,
    private readonly options: GooglePlayIntegrityDecoderOptions = {},
  ) {
    this.serviceAccount = JSON.parse(
      Buffer.from(serviceAccountJsonBase64, "base64").toString("utf8"),
    ) as ServiceAccountKey;
  }

  /**
   * Rejects with a PlayIntegrityDecodeError (class, stage and status, no
   * token or response body in it) for every failure of the two Google calls.
   */
  public async decode(token: string): Promise<{
    requestHash: string | undefined;
    appRecognitionVerdict: string;
    deviceRecognitionVerdicts: string[];
    certificateSha256Digests: string[];
  }> {
    const accessToken = await this.accessToken();
    let body: unknown;
    try {
      body = await this.postToGoogle(
        "decode",
        `https://playintegrity.googleapis.com/v1/${this.cloudProjectNumber}:decodeIntegrityToken`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ integrity_token: token }),
        },
      );
    } catch (error) {
      // Google no longer accepts the access token: do not keep handing it to
      // the next enrolment until its stated expiry.
      if (error instanceof PlayIntegrityDecodeError && error.status === 401) {
        this.cachedAccessToken = undefined;
      }
      throw error;
    }
    const payload = isRecord(body) ? body["tokenPayloadExternal"] : undefined;
    if (!isRecord(payload)) {
      throw new PlayIntegrityDecodeError("malformed_response", "decode");
    }
    const verdict = payload as TokenPayloadExternal;
    try {
      return {
        requestHash: verdict.requestDetails?.requestHash,
        appRecognitionVerdict: verdict.appIntegrity?.appRecognitionVerdict ?? "UNKNOWN",
        deviceRecognitionVerdicts: verdict.deviceIntegrity?.deviceRecognitionVerdict ?? [],
        certificateSha256Digests: (verdict.appIntegrity?.certificateSha256Digest ?? []).map(
          base64DigestToHex,
        ),
      };
    } catch (cause) {
      throw new PlayIntegrityDecodeError("malformed_response", "decode", { cause });
    }
  }

  private async accessToken(): Promise<string> {
    const cached = this.cachedAccessToken;
    if (cached !== undefined && this.now() < cached.usableUntil) {
      return cached.value;
    }
    if (this.accessTokenInFlight === undefined) {
      this.accessTokenInFlight = this.exchangeAccessToken().finally(() => {
        this.accessTokenInFlight = undefined;
      });
    }
    return this.accessTokenInFlight;
  }

  private async exchangeAccessToken(): Promise<string> {
    // Taken before the request, so a slow exchange can only shorten the
    // cached lifetime, never extend it past what Google granted.
    const requestedAt = this.now();
    const now = Math.floor(requestedAt / 1000);
    const privateKey = await importPKCS8(this.serviceAccount.private_key, "RS256");
    const assertion = await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.serviceAccount.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const body = await this.postToGoogle("oauth_token", TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
    });
    const accessToken = isRecord(body) ? body["access_token"] : undefined;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new PlayIntegrityDecodeError("malformed_response", "oauth_token");
    }
    // Cached only when Google states a lifetime that outlasts the safety
    // margin; otherwise the token is used for this decode alone.
    const expiresInSeconds = isRecord(body) ? body["expires_in"] : undefined;
    if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds)) {
      const usableUntil = requestedAt + expiresInSeconds * 1000 - ACCESS_TOKEN_EXPIRY_MARGIN_MS;
      this.cachedAccessToken =
        usableUntil > requestedAt ? { value: accessToken, usableUntil } : undefined;
    } else {
      this.cachedAccessToken = undefined;
    }
    return accessToken;
  }

  /**
   * One bounded POST to Google, returning the parsed JSON of a 2xx answer.
   * The timeout covers the connection and reading the body. Never reads the
   * body of a non-2xx answer, so nothing Google (or a proxy in front of it)
   * wrote can reach an error message or a log line.
   */
  private async postToGoogle(
    stage: PlayIntegrityDecodeStage,
    url: string,
    init: RequestInit,
  ): Promise<unknown> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? PLAY_INTEGRITY_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, { ...init, signal });
    } catch (cause) {
      throw new PlayIntegrityDecodeError(signal.aborted ? "timeout" : "network", stage, { cause });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // 400 from the decode call is Google refusing the integrity token
      // itself; a 400 from the token exchange is a credentials problem and
      // stays a plain HTTP status.
      throw new PlayIntegrityDecodeError(
        stage === "decode" && response.status === 400 ? "token_invalid" : "http_status",
        stage,
        { status: response.status },
      );
    }
    try {
      return await response.json();
    } catch (cause) {
      const failureClass = signal.aborted
        ? "timeout"
        : cause instanceof SyntaxError
          ? "malformed_response"
          : "network";
      throw new PlayIntegrityDecodeError(failureClass, stage, { cause });
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
