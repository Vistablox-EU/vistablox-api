import { describe, expect, it, vi } from "vitest";
import { ReconcileWalletRegistrationService } from "../src/modules/wallet/application/reconcile-wallet-registration.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";

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
});
