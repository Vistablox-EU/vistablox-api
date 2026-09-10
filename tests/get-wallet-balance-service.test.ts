import { describe, expect, it, vi } from "vitest";

import {
  GetWalletBalanceService,
  type WalletChainReader,
} from "../src/modules/wallet/application/get-wallet-balance.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";

const accountId = "acct_01";
const walletAddress = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";

function buildRepository(overrides: Partial<WalletRepository> = {}): WalletRepository {
  return {
    registerWallet: vi.fn(),
    findByAccountId: vi.fn().mockResolvedValue({
      walletAddress,
      registrationCommitment: "commitment_01",
      requestedAt: new Date("2026-09-02T10:00:00.000Z"),
      registeredAt: new Date("2026-09-02T10:05:00.000Z"),
    }),
    ...overrides,
  };
}

function buildHoldingsReader(
  overrides: Partial<PivTokenHoldingsReader> = {},
): PivTokenHoldingsReader {
  return {
    listTokenHoldings: vi.fn().mockResolvedValue([{ pivId: "piv_01", tokenId: "7" }]),
    ...overrides,
  };
}

function buildChainReader(overrides: Partial<WalletChainReader> = {}): WalletChainReader {
  return {
    getCapitalBalance: vi.fn().mockResolvedValue(1_250_000_000n),
    getTokenBalances: vi.fn().mockResolvedValue([3n]),
    ...overrides,
  };
}

describe("GetWalletBalanceService", () => {
  it("returns the wallet's on-chain capital and token balances", async () => {
    const repository = buildRepository();
    const holdingsReader = buildHoldingsReader();
    const chainReader = buildChainReader();
    const service = new GetWalletBalanceService(repository, holdingsReader, chainReader);

    const result = await service.execute(accountId);

    expect(result).toEqual({
      data: {
        wallet_address: walletAddress,
        capital_eurc: "1250.000000",
        tokens: [{ piv_id: "piv_01", token_id: "7", balance: "3" }],
      },
    });
    expect(chainReader.getCapitalBalance).toHaveBeenCalledWith(walletAddress);
    expect(chainReader.getTokenBalances).toHaveBeenCalledWith(walletAddress, ["7"]);
  });

  it("skips the token-balance read entirely when the account has no minted PIV holdings", async () => {
    const repository = buildRepository();
    const holdingsReader = buildHoldingsReader({ listTokenHoldings: vi.fn().mockResolvedValue([]) });
    const chainReader = buildChainReader();
    const service = new GetWalletBalanceService(repository, holdingsReader, chainReader);

    const result = await service.execute(accountId);

    expect(result.data.tokens).toEqual([]);
    expect(chainReader.getTokenBalances).not.toHaveBeenCalled();
  });

  it("rejects an account with no registered wallet", async () => {
    const repository = buildRepository({ findByAccountId: vi.fn().mockResolvedValue(null) });
    const service = new GetWalletBalanceService(repository, buildHoldingsReader(), buildChainReader());

    await expect(service.execute(accountId)).rejects.toMatchObject({
      code: "wallet.not_registered",
      status: 404,
    });
  });
});
