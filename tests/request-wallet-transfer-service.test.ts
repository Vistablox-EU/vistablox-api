import { describe, expect, it, vi } from "vitest";

import { RequestWalletTransferService } from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";
import { ChainStateUnavailableError } from "../src/shared/errors/chain-state-unavailable-error.js";
import {
  SNAPSHOT_BLOCK_HASH,
  buildPassingSnapshot,
  buildTransferChainReader,
} from "./support/wallet-transfer-fakes.js";

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

function build(chainReader = buildTransferChainReader()) {
  return {
    chainReader,
    service: new RequestWalletTransferService(buildRepository(), buildHoldingsReader(), chainReader),
  };
}

function execute(service: RequestWalletTransferService, amount = "3") {
  return service.execute({ accountId, pivId, toWalletAddress, amount });
}

describe("RequestWalletTransferService", () => {
  it("builds an unsigned transfer transaction and the preflight from one snapshot", async () => {
    const { chainReader, service } = build();

    const result = await execute(service);

    expect(result).toEqual({
      data: {
        piv_id: pivId,
        token_id: tokenId,
        amount: "3",
        from_wallet_address: walletAddress,
        to_wallet_address: toWalletAddress,
        unsigned_transaction: { chain_id: 84532, to: "0xproperty", data: "0xdeadbeef", value: "0" },
        preflight: {
          block_number: "123456",
          block_hash: SNAPSHOT_BLOCK_HASH,
          sender_balance: "10",
          recipient_authorized: true,
          token_paused: false,
          simulation: "passed",
        },
      },
    });
    expect(chainReader.readTransferSnapshot).toHaveBeenCalledTimes(1);
    expect(chainReader.readTransferSnapshot).toHaveBeenCalledWith({
      from: walletAddress,
      to: toWalletAddress,
      tokenId,
      amount: "3",
    });
  });

  it("allows transferring exactly the whole balance", async () => {
    const { service } = build(buildTransferChainReader(buildPassingSnapshot({ senderBalance: 3n })));

    await expect(execute(service, "3")).resolves.toMatchObject({
      data: { preflight: { sender_balance: "3" } },
    });
  });

  it("rejects an account with no registered wallet without reading the chain", async () => {
    const chainReader = buildTransferChainReader();
    const service = new RequestWalletTransferService(
      buildRepository({ findByAccountId: vi.fn().mockResolvedValue(null) }),
      buildHoldingsReader(),
      chainReader,
    );

    await expect(execute(service)).rejects.toMatchObject({ code: "wallet.not_registered", status: 404 });
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a PIV the account holds no minted position for without reading the chain", async () => {
    const chainReader = buildTransferChainReader();
    const service = new RequestWalletTransferService(
      buildRepository(),
      buildHoldingsReader({ listTokenHoldings: vi.fn().mockResolvedValue([]) }),
      chainReader,
    );

    await expect(execute(service)).rejects.toMatchObject({ code: "wallet.piv_not_held", status: 404 });
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ["a paused token", buildPassingSnapshot({ tokenPaused: true }), "wallet.token_paused"],
    [
      "an unauthorized recipient wallet",
      buildPassingSnapshot({ recipientAuthorized: false }),
      "wallet.recipient_not_authorized",
    ],
    [
      "an amount exceeding the wallet's on-chain balance",
      buildPassingSnapshot({ senderBalance: 2n }),
      "wallet.insufficient_balance",
    ],
    [
      "a closed transfer lane",
      buildPassingSnapshot({
        simulation: { status: "reverted", revert: { errorName: "TransferLaneClosed" } },
      }),
      "wallet.transfer_lane_closed",
    ],
    [
      "a recipient that cannot receive",
      buildPassingSnapshot({
        simulation: { status: "reverted", revert: { errorName: "ERC1155InvalidReceiver" } },
      }),
      "wallet.recipient_cannot_receive",
    ],
    [
      "an unknown revert",
      buildPassingSnapshot({ simulation: { status: "reverted", revert: {} } }),
      "wallet.transfer_would_revert",
    ],
  ])("answers 422 for %s", async (_name, snapshot, code) => {
    const { service } = build(buildTransferChainReader(snapshot));

    const error = await execute(service).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code, status: 422 });
  });

  it("keeps customer-facing text free of contract revert names", async () => {
    const { service } = build(
      buildTransferChainReader(
        buildPassingSnapshot({
          simulation: { status: "reverted", revert: { errorName: "TransferLaneClosed" } },
        }),
      ),
    );

    const error = (await execute(service).catch((caught: unknown) => caught)) as AppError;

    expect(`${error.title} ${error.message}`).not.toMatch(/TransferLaneClosed|ERC1155|revert\(/);
  });

  it("rejects an amount above uint256 as insufficient balance without reading the chain", async () => {
    const { chainReader, service } = build();

    await expect(execute(service, (2n ** 256n).toString())).rejects.toMatchObject({
      code: "wallet.insufficient_balance",
      status: 422,
    });
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();
  });

  it("accepts the largest uint256 amount into the chain read", async () => {
    const { chainReader, service } = build();

    await expect(execute(service, (2n ** 256n - 1n).toString())).rejects.toMatchObject({
      code: "wallet.insufficient_balance",
    });
    expect(chainReader.readTransferSnapshot).toHaveBeenCalledTimes(1);
  });

  it("answers 503 wallet.chain_unavailable when the chain cannot be read, without leaking the cause", async () => {
    const { service } = build(
      buildTransferChainReader(() =>
        Promise.reject(new ChainStateUnavailableError("HttpRequestError: https://rpc.example/key-secret")),
      ),
    );

    const error = (await execute(service).catch((caught: unknown) => caught)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "wallet.chain_unavailable", status: 503 });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify([error.message, error.title, error.code])).not.toMatch(/https?:|key-secret/);
  });

  it("lets any other reader failure propagate untouched so a bug is not disguised as an outage", async () => {
    const bug = new TypeError("boom");
    const { service } = build(buildTransferChainReader(() => Promise.reject(bug)));

    await expect(execute(service)).rejects.toBe(bug);
  });

  it("never mixes values between two consecutive snapshots", async () => {
    const snapshotA = buildPassingSnapshot({
      block: { number: 100n, hash: `0x${"a1".repeat(32)}` },
      senderBalance: 50n,
    });
    const snapshotB = buildPassingSnapshot({
      block: { number: 101n, hash: `0x${"b2".repeat(32)}` },
      senderBalance: 7n,
    });
    const readTransferSnapshot = vi
      .fn()
      .mockResolvedValueOnce(snapshotA)
      .mockResolvedValueOnce(snapshotB);
    const { service } = build({ readTransferSnapshot });

    const first = await execute(service);
    const second = await execute(service);

    expect(first.data.preflight).toMatchObject({
      block_number: "100",
      block_hash: `0x${"a1".repeat(32)}`,
      sender_balance: "50",
    });
    expect(second.data.preflight).toMatchObject({
      block_number: "101",
      block_hash: `0x${"b2".repeat(32)}`,
      sender_balance: "7",
    });
    expect(readTransferSnapshot).toHaveBeenCalledTimes(2);
  });
});
