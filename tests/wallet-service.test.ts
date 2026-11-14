import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { createRequireFreshAuthentication } from "../src/modules/auth/api/customer/require-fresh-authentication.js";
import type { CustomerSessionRepository } from "../src/modules/auth/repository/customer/customer-session.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import { GetWalletAccountForOperationsService } from "../src/modules/wallet/application/get-wallet-account-for-operations.service.js";
import {
  WalletAddressConflictError,
  WalletReplacementFreshAuthenticationRequiredError,
  type WalletRepository,
} from "../src/modules/wallet/repository/wallet.repository.js";
import type { KycEligibilityReader, KycEligibilitySnapshot } from "../src/modules/identity/repository/kyc-eligibility-reader.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const accountId = "acct_01";
const walletAddress = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const TEST_REGISTRY_ADDRESS = "0x1234567890123456789012345678901234567890";

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
      TEST_REGISTRY_ADDRESS,
      () => now,
      () => "commitment_01",
    );

    const result = await service.execute({ accountId, walletAddress, freshAuthentication: false });

    expect(result).toEqual({
      data: {
        wallet_address: walletAddress,
        registration_commitment: "commitment_01",
        registry_contract_address: TEST_REGISTRY_ADDRESS,
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
      freshAuthentication: false,
    });
  });

  it("forwards the caller's freshness to the repository unchanged, true or false, and never decides it itself", async () => {
    for (const freshAuthentication of [true, false]) {
      const repository = buildRepository();
      const service = new RegisterWalletService(
        repository,
        buildKycEligibilityReader(),
        TEST_REGISTRY_ADDRESS,
        () => now,
        () => "commitment_01",
      );

      await service.execute({ accountId, walletAddress, freshAuthentication });

      expect(repository.registerWallet).toHaveBeenCalledWith(
        expect.objectContaining({ freshAuthentication }),
      );
    }
  });

  it("maps a refused replacement of a pending claim to the shared fresh-authentication 403", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletReplacementFreshAuthenticationRequiredError()),
    });
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(),
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    const error = await service
      .execute({ accountId, walletAddress, freshAuthentication: false })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: "authentication.fresh_auth_required",
      title: "Fresh authentication required",
      status: 403,
      message: "Sign in again on this device before continuing.",
      type: "https://api.vistablox.io/errors/authentication.fresh_auth_required",
    });
    expect((error as AppError).fieldErrors).toBeUndefined();
  });

  it("answers with the same envelope the real fresh-authentication middleware produces", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletReplacementFreshAuthenticationRequiredError()),
    });
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(),
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    const serviceError = await service
      .execute({ accountId, walletAddress, freshAuthentication: false })
      .catch((caught: unknown) => caught);

    // The middleware built by the real factory, refusing a request that has no
    // authentication context (never fresh, and it asks no repository).
    const sessions: CustomerSessionRepository = { listForAccount: vi.fn(), findOwnedProviderSessionId: vi.fn() };
    const next = vi.fn();
    await createRequireFreshAuthentication(sessions)({} as Request, { locals: {} } as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    const middlewareError = next.mock.calls[0]![0] as unknown;

    expect(middlewareError).toBeInstanceOf(AppError);
    expect(serviceError).toBeInstanceOf(AppError);
    const expected = middlewareError as AppError;
    expect(serviceError).toMatchObject({
      code: expected.code,
      title: expected.title,
      status: expected.status,
      message: expected.message,
      type: expected.type,
    });
    expect((serviceError as AppError).fieldErrors).toEqual(expected.fieldErrors);
  });

  it("passes an unrelated repository error through unchanged", async () => {
    const failure = new Error("connection reset");
    const repository = buildRepository({ registerWallet: vi.fn().mockRejectedValue(failure) });
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(),
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    await expect(
      service.execute({ accountId, walletAddress, freshAuthentication: true }),
    ).rejects.toBe(failure);
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
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(),
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    const result = await service.execute({ accountId, walletAddress, freshAuthentication: false });

    expect(result.data).toMatchObject({ status: "registered", registered_at: now.toISOString() });
  });

  it("503s when the wallet registry contract isn't configured yet, before touching the repository", async () => {
    const repository = buildRepository();
    const service = new RegisterWalletService(repository, buildKycEligibilityReader(), undefined, () => now);

    await expect(service.execute({ accountId, walletAddress, freshAuthentication: false })).rejects.toMatchObject({
      code: "wallet.on_chain_registration_unavailable",
      status: 503,
    });
    expect(repository.registerWallet).not.toHaveBeenCalled();
  });

  it("requires current KYC eligibility", async () => {
    const repository = buildRepository();
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(null),
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    await expect(service.execute({ accountId, walletAddress, freshAuthentication: false })).rejects.toMatchObject({
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
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    await expect(service.execute({ accountId, walletAddress, freshAuthentication: false })).rejects.toMatchObject({
      code: "identity.kyc_required",
      status: 403,
    });
  });

  it("maps an address-mismatch conflict to a 409", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_mismatch")),
    });
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(),
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    await expect(service.execute({ accountId, walletAddress, freshAuthentication: false })).rejects.toMatchObject({
      code: "wallet.registration_address_mismatch",
      status: 409,
    });
  });

  it("maps an address-claimed-by-another-account conflict to a 409", async () => {
    const repository = buildRepository({
      registerWallet: vi.fn().mockRejectedValue(new WalletAddressConflictError("address_claimed")),
    });
    const service = new RegisterWalletService(
      repository,
      buildKycEligibilityReader(),
      TEST_REGISTRY_ADDRESS,
      () => now,
    );

    await expect(service.execute({ accountId, walletAddress, freshAuthentication: false })).rejects.toMatchObject({
      code: "wallet.address_already_claimed",
      status: 409,
    });
  });
});

describe("GetWalletAccountForOperationsService", () => {
  it("returns the wallet registration for the given account", async () => {
    const repository = buildRepository({
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress,
        registrationCommitment: "commitment_01",
        requestedAt: now,
        registeredAt: null,
      }),
    });
    const service = new GetWalletAccountForOperationsService(repository);

    const result = await service.execute(accountId);

    expect(result).toEqual({
      data: {
        account_id: accountId,
        wallet_address: walletAddress,
        registration_commitment: "commitment_01",
        status: "pending",
        requested_at: now.toISOString(),
        registered_at: null,
      },
    });
    expect(repository.findByAccountId).toHaveBeenCalledWith(accountId);
  });

  it("reports registered status once registered_at is set", async () => {
    const registeredAt = new Date("2026-09-02T10:05:00.000Z");
    const repository = buildRepository({
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress,
        registrationCommitment: "commitment_01",
        requestedAt: now,
        registeredAt,
      }),
    });
    const service = new GetWalletAccountForOperationsService(repository);

    const result = await service.execute(accountId);

    expect(result.data).toMatchObject({ status: "registered", registered_at: registeredAt.toISOString() });
  });

  it("404s rather than synthesizing a response for an account with no wallet on file", async () => {
    const repository = buildRepository({ findByAccountId: vi.fn().mockResolvedValue(null) });
    const service = new GetWalletAccountForOperationsService(repository);

    await expect(service.execute("acct_missing")).rejects.toMatchObject({
      code: "wallet.account_not_found",
      status: 404,
    });
  });
});
