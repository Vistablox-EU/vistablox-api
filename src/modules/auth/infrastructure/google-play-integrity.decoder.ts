import { importPKCS8, SignJWT } from "jose";

import type { PlayIntegrityVerdictDecoder } from "../application/android-attestation-verifier.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";

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

interface DecodeIntegrityTokenResponse {
  tokenPayloadExternal?: {
    requestDetails?: { requestHash?: string };
    appIntegrity?: { appRecognitionVerdict?: string; certificateSha256Digest?: string[] };
    deviceIntegrity?: { deviceRecognitionVerdict?: string[] };
  };
}

/**
 * Decodes a Play Integrity standard-request token via Google's REST API,
 * authenticating as the configured service account (decode-only role --
 * PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON, base64). Untested against the real
 * API as of this PR: PLAY_INTEGRITY_POLICY=disabled (no Play Console
 * project yet) means this path isn't live on staging -- confirm against a
 * real token once the account exists.
 */
export class GooglePlayIntegrityDecoder implements PlayIntegrityVerdictDecoder {
  private readonly serviceAccount: ServiceAccountKey;

  public constructor(
    serviceAccountJsonBase64: string,
    private readonly cloudProjectNumber: string,
  ) {
    this.serviceAccount = JSON.parse(
      Buffer.from(serviceAccountJsonBase64, "base64").toString("utf8"),
    ) as ServiceAccountKey;
  }

  public async decode(token: string): Promise<{
    requestHash: string | undefined;
    appRecognitionVerdict: string;
    deviceRecognitionVerdicts: string[];
    certificateSha256Digests: string[];
  }> {
    const accessToken = await this.fetchAccessToken();
    const response = await fetch(
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
    if (!response.ok) {
      throw new Error(`Play Integrity decode failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as DecodeIntegrityTokenResponse;
    const payload = body.tokenPayloadExternal;
    return {
      requestHash: payload?.requestDetails?.requestHash,
      appRecognitionVerdict: payload?.appIntegrity?.appRecognitionVerdict ?? "UNKNOWN",
      deviceRecognitionVerdicts: payload?.deviceIntegrity?.deviceRecognitionVerdict ?? [],
      certificateSha256Digests: (payload?.appIntegrity?.certificateSha256Digest ?? []).map(
        base64DigestToHex,
      ),
    };
  }

  private async fetchAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const privateKey = await importPKCS8(this.serviceAccount.private_key, "RS256");
    const assertion = await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.serviceAccount.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }),
    });
    if (!response.ok) {
      throw new Error(`Google OAuth2 token exchange failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { access_token: string };
    return body.access_token;
  }
}
