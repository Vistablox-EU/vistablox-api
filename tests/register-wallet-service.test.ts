import { describe, expect, it, vi } from "vitest";

import { RegisterWalletService } from "../src/modules/investor-profile/application/register-wallet.service.js";
import {
  WalletAddressConflictError,
  type InvestorProfileRecord,
  type InvestorProfileRepository,
} from "../src/modules/investor-profile/repository/investor-profile.repository.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const accountId = "acct_01";
const walletAddress = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";

function profileRecord(overrides: Partial<InvestorProfileRecord> = {}): InvestorProfileRecord {
  return {
    accountId,
    accountStatus: "active",
    protectedContactEmail: "investor@example.com",
    createdAt: new Date("2026-01-15T10:00:00.000Z"),
    loginMethods: [],
    kyc: {
      diditReference: null,
      providerStatus: null,
      eligibilityState: "eligible",
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "DE",
      proofOfAddressStatus: "current",
      proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
      lastVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
      renewalDueAt: new Date("2099-01-01T00:00:00.000Z"),
    },
    reservationCount: 0,
    activePositionCount: 0,
    walletRegistration: null,
    ...overrides,
  };
}

function buildRepository(overrides: Partial<InvestorProfileRepository> = {}): InvestorProfileRepository {
  return {
    get: vi.fn().mockResolvedValue(profileRecord()),
    registerWallet: vi.fn().mockResolvedValue({
      walletAddress,
      registrationCommitment: "commitment_01",
      requestedAt: now,
      registeredAt: null,
    }),
    listReservations: vi.fn().mockResolvedValue([]),
    listCurrentPositions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("RegisterWalletService", () => {
  it("registers a wallet with a generated commitment for a KYC-eligible account", async () => {
    const repository = buildRepository();
    const service = new RegisterWalletService(repository, () => now, () => "commitment_01");

    const result = await service.execute({ accountId, walletAddress });

    expect(result).toEqual({
      data: {
        wallet_address: walletAddress,
        registration_commitment: "commitment_01",
        status: "pending",
        requested_at: now.toISOString(),
        registered_at: null,
      },
    });
    expect(repository.registerWallet).toHaveBeenCalledWith({
      accountId,
      walletAddress,
      registrationCommitment: "commitment_01",
      requestedAt: now,
    });
  });

  it("reports the wallet as registered once registeredAt is set", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockResolvedValue({
        walletAddress,
        registrationCommitment: "commitment_01",
        requestedAt: now,
        registeredAt: now,
      }),
    });
    const service = new RegisterWalletService(repository, () => now);

    const result = await service.execute({ accountId, walletAddress });

    expect(result.data).toMatchObject({ status: "registered", registered_at: now.toISOString() });
  });

  it("404s when the account no longer exists", async () => {
    const repository = buildRepository({ get: vi.fn().mockResolvedValue(null) });
    const service = new RegisterWalletService(repository, () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "investor_profile.not_found",
      status: 404,
    });
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("blocks a restricted account", async () => {
    const repository = buildRepository({
      get: vi.fn().mockResolvedValue(profileRecord({ accountStatus: "suspended_restricted" })),
    });
    const service = new RegisterWalletService(repository, () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "account.restricted",
      status: 403,
    });
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("requires current KYC eligibility", async () => {
    const repository = buildRepository({
      get: vi.fn().mockResolvedValue(profileRecord({ kyc: null })),
    });
    const service = new RegisterWalletService(repository, () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "identity.kyc_required",
      status: 403,
    });
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("rejects a lapsed KYC renewal even if the last known state was eligible", async () => {
    const repository = buildRepository({
      get: vi.fn().mockResolvedValue(
        profileRecord({
          kyc: {
            diditReference: null,
            providerStatus: null,
            eligibilityState: "eligible",
            residenceCountryCode: "DE",
            taxResidenceCountryCode: "DE",
            proofOfAddressStatus: "current",
            proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
            lastVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
            renewalDueAt: new Date("2020-01-01T00:00:00.000Z"),
          },
        }),
      ),
    });
    const service = new RegisterWalletService(repository, () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "identity.kyc_required",
      status: 403,
    });
  });

  it("maps an address-mismatch conflict to a 409", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_mismatch")),
    });
    const service = new RegisterWalletService(repository, () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "wallet.registration_address_mismatch",
      status: 409,
    });
  });

  it("maps an address-claimed-by-another-account conflict to a 409", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_claimed")),
    });
    const service = new RegisterWalletService(repository, () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "wallet.address_already_claimed",
      status: 409,
    });
  });
});
