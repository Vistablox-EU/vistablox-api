import type { AndroidAttestationRevocationList } from "../application/android-attestation-verifier.js";

const REVOCATION_LIST_URL = "https://android.googleapis.com/attestation/status";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_CLOSED_AFTER_MS = 72 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

interface RevocationStatusResponse {
  entries: Record<string, unknown>;
}

/**
 * Google's hardware-attestation revocation list, cached in memory for
 * <=24h. Once the cache is older than 72h (the endpoint has been
 * unreachable for a while), every certificate is treated as revoked --
 * fail closed, matching the DPoP replay-pruning job's own instinct that a
 * stale safety check is worse than an obviously-broken one.
 */
export class HttpAndroidAttestationRevocationList implements AndroidAttestationRevocationList {
  private revokedSerials: Set<string> | undefined;
  private fetchedAt: number | undefined;
  // Concurrent enrolments hitting a stale cache at once must share one
  // in-flight refresh rather than each firing their own fetch at Google's
  // endpoint -- this is on the hot path of every enrolment/login
  // attestation check, not a background job.
  private refreshInFlight: Promise<void> | undefined;

  public async isRevoked(certificateSerialHex: string): Promise<boolean> {
    await this.refreshIfStale();
    if (this.revokedSerials === undefined || this.fetchedAt === undefined) {
      return true;
    }
    if (Date.now() - this.fetchedAt > FAIL_CLOSED_AFTER_MS) {
      return true;
    }
    return this.revokedSerials.has(certificateSerialHex.toLowerCase());
  }

  private async refreshIfStale(): Promise<void> {
    if (this.fetchedAt !== undefined && Date.now() - this.fetchedAt < CACHE_TTL_MS) {
      return;
    }
    if (this.refreshInFlight !== undefined) {
      await this.refreshInFlight;
      return;
    }
    this.refreshInFlight = this.refresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    await this.refreshInFlight;
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch(REVOCATION_LIST_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) return;
      const body = (await response.json()) as RevocationStatusResponse;
      this.revokedSerials = new Set(Object.keys(body.entries).map((serial) => serial.toLowerCase()));
      this.fetchedAt = Date.now();
    } catch {
      // Leave the existing cache (if any) in place -- the next call retries
      // (refreshInFlight is cleared in refreshIfStale's .finally above), and
      // isRevoked's own fail-closed check catches a cache that never recovers.
    }
  }
}
