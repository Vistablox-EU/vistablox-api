import { ContractFunctionRevertedError, HttpRequestError, TimeoutError } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { ChainReader } from "../src/infrastructure/blockchain/chain-client.js";
import { ViemWalletChainReader } from "../src/infrastructure/blockchain/chain-wallet-reader.js";
import { ChainStateUnavailableError } from "../src/shared/errors/chain-state-unavailable-error.js";

const WALLET = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
const SECRET_URL = "https://rpc.example/v2/SECRET-API-KEY-123";

function readerWith(balanceOf: () => Promise<bigint>, budgetMs?: number) {
  const chain = {
    eurc: { read: { balanceOf } },
    property: { read: { balanceOfBatch: vi.fn() } },
  } as unknown as ChainReader;
  return new ViemWalletChainReader(chain, budgetMs);
}

describe("ViemWalletChainReader balance reads", () => {
  it("returns the balance when the chain answers", async () => {
    await expect(readerWith(async () => 5n).getCapitalBalance(WALLET)).resolves.toBe(5n);
  });

  it("turns a provider outage into ChainStateUnavailableError without the URL", async () => {
    const outage = new HttpRequestError({ url: SECRET_URL, status: 503 });
    const reader = readerWith(() => Promise.reject(outage));

    const error = await reader.getCapitalBalance(WALLET).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    expect((error as Error).message).toContain("status 503");
    expect((error as Error).message).not.toContain("SECRET");
  });

  it("turns a viem timeout into ChainStateUnavailableError", async () => {
    const reader = readerWith(() => Promise.reject(new TimeoutError({ body: {}, url: SECRET_URL })));

    const error = await reader.getCapitalBalance(WALLET).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    expect((error as Error).message).not.toContain("SECRET");
  });

  it("gives up on a read that never answers once the budget is spent", async () => {
    const reader = readerWith(() => new Promise<bigint>(() => undefined), 20);

    await expect(reader.getCapitalBalance(WALLET)).rejects.toThrow(ChainStateUnavailableError);
  });

  it("leaves a contract revert alone so it is not reported as retryable", async () => {
    const revert = Object.create(ContractFunctionRevertedError.prototype) as Error;
    const reader = readerWith(() => Promise.reject(revert));

    await expect(reader.getCapitalBalance(WALLET)).rejects.not.toBeInstanceOf(
      ChainStateUnavailableError,
    );
  });
});
