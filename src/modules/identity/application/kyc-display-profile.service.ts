import type { ProtectedDisplayProfile, ProtectedProfileCache } from "../../../infrastructure/cache/protected-profile-cache.js";
import type { DiditClient } from "./didit-client.js";
import type { KycEligibilityReader } from "../repository/kyc-eligibility-reader.js";

// Relocated from vistablox-api's DiditProtectedDisplayProfileProvider
// (Phase 6): fetching a KYC decision live from Didit belongs here with
// every other Didit call, not in the API gateway. Re-derives diditReference/
// providerStatus itself via the eligibility reader rather than trusting a
// caller-supplied copy -- this process owns that data now, and vistablox-api
// only ever had it as a read of the same row in the first place.
export class GetKycDisplayProfileService {
  public constructor(
    private readonly eligibilityReader: KycEligibilityReader,
    private readonly didit: DiditClient,
    private readonly cache: ProtectedProfileCache | undefined,
    private readonly clock: () => Date = () => new Date(),
    private readonly onError: (error: unknown, operation: string) => void = () => {},
  ) {}

  public async execute(accountId: string): Promise<{
    data: {
      given_name: string;
      family_name: string;
      full_display_name: string;
      synced_at: string;
    } | null;
  }> {
    const snapshot = await this.eligibilityReader.getEligibilitySnapshot(accountId);
    if (snapshot === null || snapshot.diditReference === null || snapshot.providerStatus !== "Approved") {
      await this.tryDelete(accountId);
      return { data: null };
    }
    const diditReference = snapshot.diditReference;
    // Without a cache there is nowhere to put a fresh result, so a live
    // Didit call here would be pure waste on every single profile read --
    // mirrors UnavailableProtectedDisplayProfileProvider's old role
    // (swapped in whole, one level up, when cache/Didit weren't both
    // configured) rather than actually reaching Didit and throwing the
    // answer away.
    const cache = this.cache;
    if (cache === undefined) return { data: null };

    const cacheRead = await this.tryGet(cache, accountId);
    if (!cacheRead.available) return { data: null };
    const cached = cacheRead.profile;
    if (
      cached !== null &&
      this.clock().getTime() - cached.syncedAt.getTime() < 6 * 60 * 60 * 1_000
    ) {
      return { data: toResponse(cached) };
    }

    let decision: Awaited<ReturnType<DiditClient["getDecision"]>>;
    try {
      decision = await this.didit.getDecision(diditReference);
    } catch (error) {
      this.onError(error, "didit_profile_fetch");
      return { data: cached === null ? null : toResponse(cached) };
    }
    if (
      decision.sessionId !== diditReference ||
      decision.sessionKind === "business" ||
      decision.vendorData !== accountId ||
      decision.status !== "Approved" ||
      decision.verifiedDisplayProfile === null
    ) {
      await this.tryDelete(accountId);
      return { data: null };
    }

    const refreshed: ProtectedDisplayProfile = {
      ...decision.verifiedDisplayProfile,
      syncedAt: this.clock(),
    };
    const stored = await this.trySet(cache, accountId, refreshed);
    return { data: toResponse(stored ? refreshed : cached) };
  }

  private async tryGet(cache: ProtectedProfileCache, accountId: string): Promise<
    | { available: true; profile: ProtectedDisplayProfile | null }
    | { available: false }
  > {
    try {
      return { available: true, profile: await cache.get(accountId) };
    } catch (error) {
      this.onError(error, "profile_cache_read");
      return { available: false };
    }
  }

  private async trySet(
    cache: ProtectedProfileCache,
    accountId: string,
    profile: ProtectedDisplayProfile,
  ): Promise<boolean> {
    try {
      await cache.set(accountId, profile);
      return true;
    } catch (error) {
      this.onError(error, "profile_cache_write");
      return false;
    }
  }

  private async tryDelete(accountId: string): Promise<void> {
    if (this.cache === undefined) return;
    try {
      await this.cache.delete(accountId);
    } catch (error) {
      this.onError(error, "profile_cache_delete");
    }
  }
}

function toResponse(profile: ProtectedDisplayProfile | null): {
  given_name: string;
  family_name: string;
  full_display_name: string;
  synced_at: string;
} | null {
  if (profile === null) return null;
  return {
    given_name: profile.givenName,
    family_name: profile.familyName,
    full_display_name: profile.fullDisplayName,
    synced_at: profile.syncedAt.toISOString(),
  };
}
