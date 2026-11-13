import { describe, expect, it, vi } from "vitest";
import { ReconcileWalletRegistrationService } from "../src/modules/wallet/application/reconcile-wallet-registration.service.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { WalletAddressConflictError, WalletRegistrationChangedError, type WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";

const wallet = { walletAddress: "0x1111111111111111111111111111111111111111", registrationCommitment: "0x" + "aa".repeat(32), requestedAt: new Date("2026-01-01T00:00:00Z"), registeredAt: null };
function repo(): WalletRepository { return { registerWallet: vi.fn(), findByAccountId: vi.fn().mockResolvedValue(wallet), reconcileWalletRegistration: vi.fn().mockResolvedValue({ ...wallet, registeredAt: new Date("2026-01-01T00:01:00Z"), registrationTxHash: "0x" + "bb".repeat(32), registrationBlockNumber: 12n }) }; }

describe("ReconcileWalletRegistrationService", () => {
  it("verifies chain evidence before persisting it", async () => {
    const repository = repo();
    const verifier = { verify: vi.fn().mockResolvedValue({ blockNumber: 12n, registeredAt: new Date("2026-01-01T00:01:00Z") }) };
    const result = await new ReconcileWalletRegistrationService(repository, verifier).execute({ accountId: "acct_1", actorAccountId: "staff_1", txHash: "0x" + "bb".repeat(32) });
    expect(result.data.status).toBe("registered");
    expect(verifier.verify).toHaveBeenCalledWith({ txHash: "0x" + "bb".repeat(32), walletAddress: wallet.walletAddress, commitment: wallet.registrationCommitment });
    expect(repository.reconcileWalletRegistration).toHaveBeenCalled();
  });

  it("confirms only the registration it verified: passes the address and commitment it read", async () => {
    const repository = repo();
    const verifier = { verify: vi.fn().mockResolvedValue({ blockNumber: 12n, registeredAt: new Date("2026-01-01T00:01:00Z") }) };

    await new ReconcileWalletRegistrationService(repository, verifier).execute({ accountId: "acct_1", actorAccountId: "staff_1", txHash: "0x" + "bb".repeat(32) });

    expect(repository.reconcileWalletRegistration).toHaveBeenCalledWith({
      accountId: "acct_1",
      actorAccountId: "staff_1",
      txHash: "0x" + "bb".repeat(32),
      expectedWalletAddress: wallet.walletAddress,
      expectedRegistrationCommitment: wallet.registrationCommitment,
      blockNumber: 12n,
      registeredAt: new Date("2026-01-01T00:01:00Z"),
    });
  });

  it("answers 409 wallet.registration_changed when the account replaced its claim after it was verified", async () => {
    const repository = repo();
    vi.mocked(repository.reconcileWalletRegistration!).mockRejectedValue(new WalletRegistrationChangedError());
    const verifier = { verify: vi.fn().mockResolvedValue({ blockNumber: 12n, registeredAt: new Date("2026-01-01T00:01:00Z") }) };

    const failure = await new ReconcileWalletRegistrationService(repository, verifier)
      .execute({ accountId: "acct_1", actorAccountId: "staff_1", txHash: "0x" + "bb".repeat(32) })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "wallet.registration_changed", status: 409 });
  });

  it("answers 409 wallet.address_already_claimed when another account holds the address confirmed", async () => {
    const repository = repo();
    vi.mocked(repository.reconcileWalletRegistration!).mockRejectedValue(new WalletAddressConflictError("address_claimed"));
    const verifier = { verify: vi.fn().mockResolvedValue({ blockNumber: 12n, registeredAt: new Date("2026-01-01T00:01:00Z") }) };

    const failure = await new ReconcileWalletRegistrationService(repository, verifier)
      .execute({ accountId: "acct_1", actorAccountId: "staff_1", txHash: "0x" + "bb".repeat(32) })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "wallet.address_already_claimed", status: 409 });
  });

  it("lets an unrelated repository failure through unchanged", async () => {
    const repository = repo();
    vi.mocked(repository.reconcileWalletRegistration!).mockRejectedValue(new Error("connection reset"));
    const verifier = { verify: vi.fn().mockResolvedValue({ blockNumber: 12n, registeredAt: new Date("2026-01-01T00:01:00Z") }) };

    await expect(
      new ReconcileWalletRegistrationService(repository, verifier).execute({ accountId: "acct_1", actorAccountId: "staff_1", txHash: "0x" + "bb".repeat(32) }),
    ).rejects.toThrow("connection reset");
  });
});
