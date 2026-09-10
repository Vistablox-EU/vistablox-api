import { describe, expect, it, vi } from "vitest";

import { IdentityDisplayProfileProvider } from "../src/infrastructure/profile/identity-display-profile.provider.js";
import type { ProtectedProfileCache } from "../src/infrastructure/cache/protected-profile-cache.js";
import type { DiditClient } from "../src/modules/identity/application/didit-client.js";
import { GetKycDisplayProfileService } from "../src/modules/identity/application/kyc-display-profile.service.js";
import type {
  KycEligibilityReader,
  KycEligibilitySnapshot,
} from "../src/modules/identity/repository/kyc-eligibility-reader.js";

const accountId = "acct_01";
const now = new Date("2026-09-01T12:00:00.000Z");

const eligibleSnapshot: KycEligibilitySnapshot = {
  accountId,
  diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  providerStatus: "Approved",
  eligibilityState: "eligible",
  residenceCountryCode: "DE",
  taxResidenceCountryCode: "DE",
  proofOfAddressStatus: "not_started",
  proofOfAddressCurrentUntil: null,
  lastVerifiedAt: null,
  renewalDueAt: null,
};

function fakeEligibilityReader(
  result: KycEligibilitySnapshot | null = eligibleSnapshot,
): KycEligibilityReader {
  return { getEligibilitySnapshot: vi.fn().mockResolvedValue(result) };
}

function fakeDiditClient(): DiditClient {
  return { createSession: vi.fn(), getDecision: vi.fn() };
}

function fakeProfileCache(overrides: Partial<ProtectedProfileCache> = {}): ProtectedProfileCache {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Builds a real GetKycDisplayProfileService (identity's own service) rather
// than faking it -- it's a concrete class, and this mirrors how
// kyc-display-profile-service.test.ts already exercises the same service.
function buildService(overrides?: {
  eligibilityReader?: KycEligibilityReader;
  cache?: ProtectedProfileCache;
}): { service: GetKycDisplayProfileService; eligibilityReader: KycEligibilityReader } {
  const eligibilityReader = overrides?.eligibilityReader ?? fakeEligibilityReader();
  const service = new GetKycDisplayProfileService(
    eligibilityReader,
    fakeDiditClient(),
    overrides?.cache ?? fakeProfileCache(),
    () => now,
  );
  return { service, eligibilityReader };
}

describe("IdentityDisplayProfileProvider", () => {
  it("skips the lookup when there is no Didit reference", async () => {
    const { service, eligibilityReader } = buildService();

    const result = await new IdentityDisplayProfileProvider(service).get({
      accountId,
      diditReference: null,
      providerStatus: null,
    });

    expect(result).toBeNull();
    expect(eligibilityReader.getEligibilitySnapshot).not.toHaveBeenCalled();
  });

  it("skips the lookup when the provider status isn't Approved", async () => {
    const { service, eligibilityReader } = buildService();

    const result = await new IdentityDisplayProfileProvider(service).get({
      accountId,
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "In Review",
    });

    expect(result).toBeNull();
    expect(eligibilityReader.getEligibilitySnapshot).not.toHaveBeenCalled();
  });

  it("maps a returned display profile to the port's camelCase shape", async () => {
    const { service } = buildService({
      cache: fakeProfileCache({
        get: vi.fn().mockResolvedValue({
          givenName: "Carmen",
          familyName: "Silva",
          fullDisplayName: "Carmen Silva",
          syncedAt: now,
        }),
      }),
    });

    const result = await new IdentityDisplayProfileProvider(service).get({
      accountId,
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "Approved",
    });

    expect(result).toEqual({
      givenName: "Carmen",
      familyName: "Silva",
      fullDisplayName: "Carmen Silva",
      syncedAt: now,
    });
  });

  it("degrades to null and reports the error when the lookup fails", async () => {
    const onError = vi.fn();
    const { service } = buildService({
      eligibilityReader: {
        getEligibilitySnapshot: vi.fn().mockRejectedValue(new Error("database unavailable")),
      },
    });

    const result = await new IdentityDisplayProfileProvider(service, onError).get({
      accountId,
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "Approved",
    });

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "kyc_display_profile_fetch");
  });
});
