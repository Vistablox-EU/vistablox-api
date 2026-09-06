import { describe, expect, it, vi } from "vitest";

import { GetInvestorProfileService } from "../src/modules/investor-profile/application/get-investor-profile.service.js";
import type { ProtectedDisplayProfileProvider } from "../src/modules/investor-profile/application/protected-display-profile.js";
import type {
  InvestorProfileRecord,
  InvestorProfileRepository,
} from "../src/modules/investor-profile/repository/investor-profile.repository.js";

const now = new Date("2026-09-01T12:00:00.000Z");
const accountId = "acct_01";

function profileRecord(
  overrides: Partial<InvestorProfileRecord> = {},
): InvestorProfileRecord {
  return {
    accountId,
    accountStatus: "active",
    protectedContactEmail: "investor@example.com",
    createdAt: new Date("2026-01-15T10:00:00.000Z"),
    loginMethods: [
      { methodType: "google", linkedAt: new Date("2026-01-15T10:00:00.000Z") },
      {
        methodType: "apple",
        linkedAt: new Date("2026-01-16T10:00:00.000Z"),
      },
      { methodType: "passkey", linkedAt: new Date("2026-01-17T10:00:00.000Z") },
    ],
    kyc: {
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "Approved",
      eligibilityState: "eligible",
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "HR",
      proofOfAddressStatus: "current",
      proofOfAddressCurrentUntil: new Date("2026-09-01T11:59:59.000Z"),
      lastVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
      renewalDueAt: new Date("2028-08-01T12:00:00.000Z"),
    },
    reservationCount: 3,
    activePositionCount: 2,
    walletRegistration: {
      requestedAt: new Date("2026-08-10T12:00:00.000Z"),
      registeredAt: new Date("2026-08-11T12:00:00.000Z"),
    },
    ...overrides,
  };
}

describe("investor profile service", () => {
  it("assembles durable account data with the protected display profile", async () => {
    const repository: InvestorProfileRepository = {
      get: vi.fn().mockResolvedValue(profileRecord()),
      registerWallet: vi.fn(),
      listReservations: vi.fn().mockResolvedValue([]),
      listCurrentPositions: vi.fn().mockResolvedValue([]),
    };
    const displayProfiles: ProtectedDisplayProfileProvider = {
      get: vi.fn().mockResolvedValue({
        givenName: "Carmen",
        familyName: "Silva",
        fullDisplayName: "Carmen Silva",
        syncedAt: new Date("2026-09-01T10:00:00.000Z"),
      }),
    };

    const result = await new GetInvestorProfileService(
      repository,
      displayProfiles,
      () => now,
    ).execute(accountId);

    expect(displayProfiles.get).toHaveBeenCalledWith({
      accountId,
      diditReference: "c2237bc6-a76c-4933-b329-6c81843b45c7",
      providerStatus: "Approved",
    });
    expect(result).toEqual({
      data: {
        account_id: accountId,
        account_status: "active",
        contact_email: "investor@example.com",
        member_since: "2026-01-15T10:00:00.000Z",
        display_profile: {
          given_name: "Carmen",
          family_name: "Silva",
          full_display_name: "Carmen Silva",
          last_synced_at: "2026-09-01T10:00:00.000Z",
        },
        login_methods: [
          { method_type: "google", linked_at: "2026-01-15T10:00:00.000Z" },
          {
            method_type: "apple",
            linked_at: "2026-01-16T10:00:00.000Z",
          },
          { method_type: "passkey", linked_at: "2026-01-17T10:00:00.000Z" },
        ],
        kyc: {
          eligibility_state: "eligible",
          residence_country_code: "DE",
          tax_residence_country_code: "HR",
          proof_of_address_status: "expired",
          proof_of_address_current_until: "2026-09-01T11:59:59.000Z",
          last_verified_at: "2026-08-01T12:00:00.000Z",
          renewal_due_at: "2028-08-01T12:00:00.000Z",
        },
        investment_summary: { reservation_count: 3, active_position_count: 2 },
        readiness: {
          investment_eligible: true,
          payment_account_ready: true,
          payout_account_verified: true,
        },
        wallet: {
          status: "registered",
          requested_at: "2026-08-10T12:00:00.000Z",
          registered_at: "2026-08-11T12:00:00.000Z",
        },
      },
    });
  });

  it("returns a stable not-found error when the account disappeared", async () => {
    const repository: InvestorProfileRepository = {
      get: vi.fn().mockResolvedValue(null),
      registerWallet: vi.fn(),
      listReservations: vi.fn().mockResolvedValue([]),
      listCurrentPositions: vi.fn().mockResolvedValue([]),
    };
    const displayProfiles: ProtectedDisplayProfileProvider = {
      get: vi.fn(),
    };

    await expect(
      new GetInvestorProfileService(repository, displayProfiles).execute(accountId),
    ).rejects.toMatchObject({ code: "investor_profile.not_found", status: 404 });
    expect(displayProfiles.get).not.toHaveBeenCalled();
  });
});
