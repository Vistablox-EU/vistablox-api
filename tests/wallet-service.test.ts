import { describe, expect, it, vi } from "vitest";

import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import {
  WalletAddressConflictError,
  type WalletRepository,
} from "../src/modules/wallet/repository/wallet.repository.js";
import type { KycEligibilityReader, KycEligibilitySnapshot } from "../src/modules/identity/repository/kyc-eligibility-reader.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const accountId = "acct_01";
const walletAddress = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";

function eligibleKyc(overrides: Partial<KycEligibilitySnapshot> = {}): KycEligibilitySnapshot {
  return {
    accountId,
    diditReference: null,
    providerStatus: null,
    eligibilityState: "eligible",
    residenceCountryCode: "DE",
    taxResidenceCountryCode: "DE",
    proofOfAddressStatus: "current",
    proofOfAddressCurrentUntil: new Date("2099-01-01T00:00:00.000Z"),
    lastVerifiedAt: new Date("2026-08-01T12:00:00.000Z"),
    renewalDueAt: new Date("2099-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function buildRepository(overrides: Partial<WalletRepository> = {}): WalletRepository {
  return {
    registerWallet: vi.fn().mockResolvedValue({
      walletAddress,
      registrationCommitment: "commitment_01",
      requestedAt: now,
      registeredAt: null,
    }),
    findByAccountId: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function buildKycEligibilityReader(
  snapshot: KycEligibilitySnapshot | null = eligibleKyc(),
): KycEligibilityReader {
  return { getEligibilitySnapshot: vi.fn().mockResolvedValue(snapshot) };
}

describe("RegisterWalletService", () => {
  it("registers a wallet with a generated commitment for a KYC-eligible account", async () => {
    const repository = buildRepository();
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(),
      () => now,
      () => "commitment_01",
    );

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
    const service = new RegisterWalletService(repository, buildKycEligibilityReader(), () => now);

    const result = await service.execute({ accountId, walletAddress });

    expect(result.data).toMatchObject({ status: "registered", registered_at: now.toISOString() });
  });

  it("requires current KYC eligibility", async () => {
    const repository = buildRepository();
    const service = new RegisterWalletService(repository, buildKycEligibilityReader(null), () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "identity.kyc_required",
      status: 403,
    });
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("rejects a lapsed KYC renewal even if the last known state was eligible", async () => {
    const repository = buildRepository();
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(eligibleKyc({ renewalDueAt: new Date("2020-01-01T00:00:00.000Z") })),
      () => now,
    );

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "identity.kyc_required",
      status: 403,
    });
  });

  it("maps an address-mismatch conflict to a 409", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_mismatch")),
    });
    const service = new RegisterWalletService(repository, buildKycEligibilityReader(), () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "wallet.registration_address_mismatch",
      status: 409,
    });
  });

  it("maps an address-claimed-by-another-account conflict to a 409", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_claimed")),
    });
    const service = new RegisterWalletService(repository, buildKycEligibilityReader(), () => now);

    await expect(service.execute({ accountId, walletAddress })).rejects.toMatchObject({
      code: "wallet.address_already_claimed",
      status: 409,
    });
  });
});
