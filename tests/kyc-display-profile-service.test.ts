import { describe, expect, it, vi } from "vitest";

import { GetKycDisplayProfileService } from "../src/modules/identity/application/kyc-display-profile.service.js";
import type { ProtectedProfileCache } from "../src/infrastructure/cache/protected-profile-cache.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import type { DiditDecisionSummary } from "../src/modules/identity/domain/kyc-policy.js";
import type {
  KycEligibilityReader,
  KycEligibilitySnapshot,
} from "../src/modules/identity/repository/kyc-eligibility-reader.js";

const accountId = "acct_01";
const sessionId = "c2237bc6-a76c-4933-b329-6c81843b45c7";
const now = new Date("2026-09-01T12:00:00.000Z");

function snapshot(overrides: Partial<KycEligibilitySnapshot> = {}): KycEligibilitySnapshot {
  return {
    accountId,
    diditReference: sessionId,
    providerStatus: "Approved",
    eligibilityState: "eligible",
    residenceCountryCode: "DE",
    taxResidenceCountryCode: "DE",
    proofOfAddressStatus: "not_started",
    proofOfAddressCurrentUntil: null,
    lastVerifiedAt: null,
    renewalDueAt: null,
    ...overrides,
  };
}

function eligibilityReader(result: KycEligibilitySnapshot | null = snapshot()): KycEligibilityReader {
  return { getEligibilitySnapshot: vi.fn().mockResolvedValue(result) };
}

function cache(overrides: Partial<ProtectedProfileCache> = {}): ProtectedProfileCache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function decision(overrides: Partial<DiditDecisionSummary> = {}): DiditDecisionSummary {
  return {
    sessionId,
    sessionKind: "user",
    workflowId: "269214fe-77f7-4b1a-a028-b70e861d73c1",
    vendorData: accountId,
    status: "Approved",
    idVerifications: [],
    livenessChecks: [],
    faceMatches: [],
    amlScreenings: [],
    proofOfAddressVerifications: [],
    verifiedDisplayProfile: {
      givenName: "Carmen",
      familyName: "Silva",
      fullDisplayName: "Carmen Silva",
    },
    ...overrides,
  };
}

function didit(result: DiditDecisionSummary = decision()): DiditClient {
  return {
    createSession: vi.fn(),
    getDecision: vi.fn().mockResolvedValue(result),
  };
}

describe("GetKycDisplayProfileService", () => {
  it("serves a profile younger than six hours without calling Didit", async () => {
    const protectedCache = cache({
      get: vi.fn().mockResolvedValue({
        givenName: "Carmen",
        familyName: "Silva",
        fullDisplayName: "Carmen Silva",
        syncedAt: new Date("2026-09-01T07:00:01.000Z"),
      }),
    });
    const provider = didit();

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(),
      provider,
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toMatchObject({ data: { full_display_name: "Carmen Silva" } });
    expect(provider.getDecision).not.toHaveBeenCalled();
  });

  it("refreshes a cache miss from a correlated approved Didit decision", async () => {
    const protectedCache = cache();
    const provider = didit();

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(),
      provider,
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({
      data: {
        given_name: "Carmen",
        family_name: "Silva",
        full_display_name: "Carmen Silva",
        synced_at: now.toISOString(),
      },
    });
    expect(protectedCache.set).toHaveBeenCalledWith(accountId, {
      givenName: "Carmen",
      familyName: "Silva",
      fullDisplayName: "Carmen Silva",
      syncedAt: now,
    });
  });

  it("uses stale cached names when the Didit refresh is temporarily unavailable", async () => {
    const stale = {
      givenName: "Carmen",
      familyName: "Silva",
      fullDisplayName: "Carmen Silva",
      syncedAt: new Date("2026-09-01T05:00:00.000Z"),
    };
    const protectedCache = cache({ get: vi.fn().mockResolvedValue(stale) });
    const provider = didit();
    vi.mocked(provider.getDecision).mockRejectedValue(new Error("offline"));

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(),
      provider,
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({
      data: {
        given_name: "Carmen",
        family_name: "Silva",
        full_display_name: "Carmen Silva",
        synced_at: stale.syncedAt.toISOString(),
      },
    });
    expect(protectedCache.set).not.toHaveBeenCalled();
  });

  it("omits names without calling Didit when the protected cache is unavailable", async () => {
    const protectedCache = cache({
      get: vi.fn().mockRejectedValue(new Error("cache offline")),
    });
    const provider = didit();

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(),
      provider,
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({ data: null });
    expect(provider.getDecision).not.toHaveBeenCalled();
  });

  it("does not expose freshly fetched names when they cannot enter the cache", async () => {
    const protectedCache = cache({
      set: vi.fn().mockRejectedValue(new Error("cache write failed")),
    });

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(),
      didit(),
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({ data: null });
  });

  it("rejects and deletes an uncorrelated provider decision", async () => {
    const protectedCache = cache();
    const provider = didit(decision({ vendorData: "acct_other" }));

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(),
      provider,
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({ data: null });
    expect(protectedCache.delete).toHaveBeenCalledWith(accountId);
  });

  it("returns null without touching the cache or Didit when there is no eligibility record", async () => {
    const protectedCache = cache();
    const provider = didit();

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(null),
      provider,
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({ data: null });
    expect(protectedCache.get).not.toHaveBeenCalled();
    expect(provider.getDecision).not.toHaveBeenCalled();
  });

  it("returns null and clears any stale entry when there is no Didit reference on file", async () => {
    const protectedCache = cache();

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(snapshot({ diditReference: null })),
      didit(),
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({ data: null });
    expect(protectedCache.delete).toHaveBeenCalledWith(accountId);
  });

  it("returns null and clears any stale entry when the provider status isn't Approved", async () => {
    const protectedCache = cache();

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(snapshot({ providerStatus: "In Review" })),
      didit(),
      protectedCache,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({ data: null });
    expect(protectedCache.delete).toHaveBeenCalledWith(accountId);
  });

  it("returns null without calling Didit when no cache is configured", async () => {
    const provider = didit();

    const result = await new GetKycDisplayProfileService(
      eligibilityReader(),
      provider,
      undefined,
      () => now,
    ).execute(accountId);

    expect(result).toEqual({ data: null });
    expect(provider.getDecision).not.toHaveBeenCalled();
  });
});
