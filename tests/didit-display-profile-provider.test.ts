import { describe, expect, it, vi } from "vitest";

import { DiditProtectedDisplayProfileProvider } from "../src/infrastructure/profile/didit-protected-display-profile.provider.js";
import type { ProtectedProfileCache } from "../src/infrastructure/cache/protected-profile-cache.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import type { DiditDecisionSummary } from "../src/modules/identity/domain/kyc-policy.js";

const accountId = "acct_01";
const sessionId = "c2237bc6-a76c-4933-b329-6c81843b45c7";
const now = new Date("2026-09-01T12:00:00.000Z");

function cache(overrides: Partial<ProtectedProfileCache> = {}): ProtectedProfileCache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function decision(
  overrides: Partial<DiditDecisionSummary> = {},
): DiditDecisionSummary {
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

const input = {
  accountId,
  diditReference: sessionId,
  providerStatus: "Approved",
};

describe("Didit protected display profile provider", () => {
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

    await expect(
      new DiditProtectedDisplayProfileProvider(
        protectedCache,
        provider,
        () => now,
      ).get(input),
    ).resolves.toMatchObject({ fullDisplayName: "Carmen Silva" });
    expect(provider.getDecision).not.toHaveBeenCalled();
  });

  it("refreshes a cache miss from a correlated approved Didit decision", async () => {
    const protectedCache = cache();
    const provider = didit();

    const result = await new DiditProtectedDisplayProfileProvider(
      protectedCache,
      provider,
      () => now,
    ).get(input);

    expect(result).toEqual({
      givenName: "Carmen",
      familyName: "Silva",
      fullDisplayName: "Carmen Silva",
      syncedAt: now,
    });
    expect(protectedCache.set).toHaveBeenCalledWith(accountId, result);
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

    await expect(
      new DiditProtectedDisplayProfileProvider(
        protectedCache,
        provider,
        () => now,
      ).get(input),
    ).resolves.toEqual(stale);
    expect(protectedCache.set).not.toHaveBeenCalled();
  });

  it("omits names without calling Didit when the protected cache is unavailable", async () => {
    const protectedCache = cache({
      get: vi.fn().mockRejectedValue(new Error("cache offline")),
    });
    const provider = didit();

    await expect(
      new DiditProtectedDisplayProfileProvider(
        protectedCache,
        provider,
        () => now,
      ).get(input),
    ).resolves.toBeNull();
    expect(provider.getDecision).not.toHaveBeenCalled();
  });

  it("does not expose freshly fetched names when they cannot enter the cache", async () => {
    const protectedCache = cache({
      set: vi.fn().mockRejectedValue(new Error("cache write failed")),
    });

    await expect(
      new DiditProtectedDisplayProfileProvider(
        protectedCache,
        didit(),
        () => now,
      ).get(input),
    ).resolves.toBeNull();
  });

  it("rejects and deletes an uncorrelated provider decision", async () => {
    const protectedCache = cache();
    const provider = didit(decision({ vendorData: "acct_other" }));

    await expect(
      new DiditProtectedDisplayProfileProvider(
        protectedCache,
        provider,
        () => now,
      ).get(input),
    ).resolves.toBeNull();
    expect(protectedCache.delete).toHaveBeenCalledWith(accountId);
  });
});
