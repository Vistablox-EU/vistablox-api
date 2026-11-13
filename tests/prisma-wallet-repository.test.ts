import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "../src/infrastructure/database/prisma.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";

// Rows written before wallet_registrations_wallet_address_lowercase_check
// existed may still carry the spelling the client sent (the migration lower-
// cases them, but a replay must not depend on that having happened). The
// canonical comparison has to return the stored row for such a row rather
// than treat the canonical retry as a different address.
describe("PrismaWalletRepository.registerWallet against a legacy mixed-case row", () => {
  it("returns the stored row for a retry in canonical form instead of reporting a mismatch", async () => {
    const legacyRow = {
      walletAddress: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
      registrationCommitment: "commitment_legacy",
      requestedAt: new Date("2026-09-02T10:00:00.000Z"),
      registeredAt: null,
      registrationTxHash: null,
      registrationBlockNumber: null,
    };
    const transaction = {
      walletRegistration: { findUnique: vi.fn().mockResolvedValue(legacyRow), create: vi.fn() },
      $queryRaw: vi.fn(),
      auditLog: { create: vi.fn() },
    };
    const database = {
      $transaction: vi.fn(async (callback: (client: typeof transaction) => unknown) => callback(transaction)),
    } as unknown as DatabaseClient;

    const result = await new PrismaWalletRepository(database).registerWallet({
      accountId: "acct_01",
      walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
      registrationCommitment: "commitment_new",
      requestedAt: new Date("2026-11-13T10:00:00.000Z"),
    });

    expect(result).toBe(legacyRow);
    expect(transaction.walletRegistration.create).not.toHaveBeenCalled();
    expect(transaction.auditLog.create).not.toHaveBeenCalled();
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
  });
});
