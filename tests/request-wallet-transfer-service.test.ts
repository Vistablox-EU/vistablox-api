import { describe, expect, it, vi } from "vitest";

import {
  RequestWalletTransferService,
  type WalletTransferChainReader,
} from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";

const accountId = "acct_01";
const walletAddress = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const toWalletAddress = "0x00000000219ab540356cbb839cbe05303d7705fa";
const pivId = "piv_01";
const tokenId = "7";

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
    listTokenHoldings: vi.fn().mockResolvedValue([{ pivId, tokenId }]),
    ...overrides,
  };
}

function buildChainReader(overrides: Partial<WalletTransferChainReader> = {}): WalletTransferChainReader {
  return {
    getTokenBalance: vi.fn().mockResolvedValue(10n),
    isHolderAuthorized: vi.fn().mockResolvedValue(true),
    isTokenPaused: vi.fn().mockResolvedValue(false),
    buildTransferRequest: vi.fn().mockReturnValue({
      chainId: 84532,
      to: "0xproperty",
      data: "0xdeadbeef",
      value: "0",
    }),
    ...overrides,
  };
}

describe("RequestWalletTransferService", () => {
  it("builds an unsigned transfer transaction for a held PIV token", async () => {
    const repository = buildRepository();
    const holdingsReader = buildHoldingsReader();
    const chainReader = buildChainReader();
    const service = new RequestWalletTransferService(repository, holdingsReader, chainReader);

    const result = await service.execute({ accountId, pivId, toWalletAddress, amount: "3" });

    expect(result).toEqual({
      data: {
        piv_id: pivId,
        token_id: tokenId,
        amount: "3",
        from_wallet_address: walletAddress,
        to_wallet_address: toWalletAddress,
        unsigned_transaction: { chain_id: 84532, to: "0xproperty", data: "0xdeadbeef", value: "0" },
      },
    });
    expect(chainReader.buildTransferRequest).toHaveBeenCalledWith({
      from: walletAddress,
      to: toWalletAddress,
      tokenId,
      amount: "3",
    });
  });

  it("rejects an account with no registered wallet", async () => {
    const repository = buildRepository({ findByAccountId: vi.fn().mockResolvedValue(null) });
    const service = new RequestWalletTransferService(
      repository,
      buildHoldingsReader(),
      buildChainReader(),
    );

    await expect(
      service.execute({ accountId, pivId, toWalletAddress, amount: "3" }),
    ).rejects.toMatchObject({ code: "wallet.not_registered", status: 404 });
  });

  it("rejects a PIV the account holds no minted position for", async () => {
    const service = new RequestWalletTransferService(
      buildRepository(),
      buildHoldingsReader({ listTokenHoldings: vi.fn().mockResolvedValue([]) }),
      buildChainReader(),
    );

    await expect(
      service.execute({ accountId, pivId, toWalletAddress, amount: "3" }),
    ).rejects.toMatchObject({ code: "wallet.piv_not_held", status: 404 });
  });

  it("rejects a paused token before checking authorization or balance", async () => {
    const chainReader = buildChainReader({ isTokenPaused: vi.fn().mockResolvedValue(true) });
    const service = new RequestWalletTransferService(buildRepository(), buildHoldingsReader(), chainReader);

    await expect(
      service.execute({ accountId, pivId, toWalletAddress, amount: "3" }),
    ).rejects.toMatchObject({ code: "wallet.token_paused", status: 422 });
    expect(chainReader.buildTransferRequest).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized recipient wallet", async () => {
    const chainReader = buildChainReader({ isHolderAuthorized: vi.fn().mockResolvedValue(false) });
    const service = new RequestWalletTransferService(buildRepository(), buildHoldingsReader(), chainReader);

    await expect(
      service.execute({ accountId, pivId, toWalletAddress, amount: "3" }),
    ).rejects.toMatchObject({ code: "wallet.recipient_not_authorized", status: 422 });
    expect(chainReader.buildTransferRequest).not.toHaveBeenCalled();
  });

  it("rejects an amount exceeding the wallet's on-chain balance", async () => {
    const chainReader = buildChainReader({ getTokenBalance: vi.fn().mockResolvedValue(2n) });
    const service = new RequestWalletTransferService(buildRepository(), buildHoldingsReader(), chainReader);

    await expect(
      service.execute({ accountId, pivId, toWalletAddress, amount: "3" }),
    ).rejects.toMatchObject({ code: "wallet.insufficient_balance", status: 422 });
    expect(chainReader.buildTransferRequest).not.toHaveBeenCalled();
  });
});
