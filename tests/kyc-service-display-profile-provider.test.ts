import { describe, expect, it, vi } from "vitest";

import { KycServiceDisplayProfileProvider } from "../src/infrastructure/profile/kyc-service-display-profile.provider.js";
import type { KycServiceGateway } from "../src/modules/identity/application/kyc-service-gateway.js";

const accountId = "acct_01";

function gateway(overrides: Partial<KycServiceGateway> = {}): KycServiceGateway {
  return {
    getStatus: vi.fn(),
    startSession: vi.fn(),
    startProofOfAddressSession: vi.fn(),
    getAccountForOperations: vi.fn(),
    getDisplayProfile: vi.fn().mockResolvedValue({ data: null }),
    ...overrides,
  };
}

describe("KycServiceDisplayProfileProvider", () => {
  it("skips the internal call when there is no Didit reference", async () => {
    const kycService = gateway();

    const result = await new KycServiceDisplayProfileProvider(kycService).get({
      accountId,
      diditReference: null,
      providerStatus: null,
    });

    expect(result).toBeNull();
    expect(kycService.getDisplayProfile).not.toHaveBeenCalled();
  });

  it("skips the internal call when the provider status isn't Approved", async () => {
    const kycService = gateway();

    const result = await new KycServiceDisplayProfileProvider(kycService).get({
      accountId,
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "In Review",
    });

    expect(result).toBeNull();
    expect(kycService.getDisplayProfile).not.toHaveBeenCalled();
  });

  it("maps a returned display profile to the port's camelCase shape", async () => {
    const kycService = gateway({
      getDisplayProfile: vi.fn().mockResolvedValue({
        data: {
          given_name: "Carmen",
          family_name: "Silva",
          full_display_name: "Carmen Silva",
          synced_at: "2026-09-01T12:00:00.000Z",
        },
      }),
    });

    const result = await new KycServiceDisplayProfileProvider(kycService).get({
      accountId,
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "Approved",
    });

    expect(result).toEqual({
      givenName: "Carmen",
      familyName: "Silva",
      fullDisplayName: "Carmen Silva",
      syncedAt: new Date("2026-09-01T12:00:00.000Z"),
    });
    expect(kycService.getDisplayProfile).toHaveBeenCalledWith(accountId);
  });

  it("degrades to null and reports the error when the KYC service call fails", async () => {
    const onError = vi.fn();
    const kycService = gateway({
      getDisplayProfile: vi.fn().mockRejectedValue(new Error("kyc service unavailable")),
    });

    const result = await new KycServiceDisplayProfileProvider(kycService, onError).get({
      accountId,
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "Approved",
    });

    expect(result).toBeNull();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "kyc_service_display_profile_fetch");
  });
});
