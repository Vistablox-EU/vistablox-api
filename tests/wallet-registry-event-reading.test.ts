import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";

import { createChainClients } from "../src/infrastructure/blockchain/chain-client.js";
import { ConfirmWalletRegistrationsService } from "../src/modules/settlement/application/confirm-wallet-registrations.service.js";
import {
  COMMITMENT,
  REGISTRY,
  WALLET,
  hexHash,
  rawLog,
  registeredData,
  registeredTopics,
} from "./support/wallet-registry-logs.js";
import { FakeWalletRegistrationRepository } from "./support/wallet-registration-fakes.js";

// The real viem client and the real contract binding, talking JSON-RPC to a
// stub node over HTTP. The unit-test fakes of the watcher cannot catch a
// mistake in how the log query is *called*: the first version of the job passed
// the block range as the only argument to getEvents.WalletRegistered, which
// viem reads as the indexed-argument filter, so eth_getLogs went out without a
// range and no event was ever seen -- while every fake-based test passed.

const EVENT_BLOCK = 0xff0; // 4080
const HEAD = 0x1000; // 4096

interface StubNode {
  server: Server;
  url: string;
  requests: Array<{ method: string; params: unknown[] }>;
  state: {
    canonicalHash: string | null; // eth_getBlockByNumber for the event block
    receipt: "present" | "missing";
    receiptBlockHash: string;
  };
}

let node: StubNode | undefined;

function blockBody(hash: string) {
  const zero32 = hexHash("00");
  return {
    number: `0x${EVENT_BLOCK.toString(16)}`,
    hash,
    parentHash: zero32,
    timestamp: "0x1",
    transactions: [],
    uncles: [],
    nonce: "0x0000000000000000",
    sha3Uncles: zero32,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: zero32,
    stateRoot: zero32,
    receiptsRoot: zero32,
    miner: `0x${"00".repeat(20)}`,
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x1",
    gasLimit: "0x1",
    gasUsed: "0x0",
    baseFeePerGas: "0x1",
    mixHash: zero32,
    blobGasUsed: "0x0",
    excessBlobGas: "0x0",
  };
}

async function startNode(): Promise<StubNode> {
  const requests: StubNode["requests"] = [];
  const state: StubNode["state"] = {
    canonicalHash: `0x${"AA".repeat(32)}`, // upper case on purpose: the stored form must still be lower case
    receipt: "present",
    receiptBlockHash: `0x${"AA".repeat(32)}`,
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      requests.push({ method: rpc.method, params: rpc.params });
      let result: unknown = null;
      if (rpc.method === "eth_blockNumber") result = `0x${HEAD.toString(16)}`;
      if (rpc.method === "eth_getLogs") {
        const filter = rpc.params[0] as { fromBlock?: string; toBlock?: string };
        // A node that honours the range: without fromBlock/toBlock this is the
        // default "latest" window, which does not contain the event.
        const from = filter.fromBlock === undefined || filter.fromBlock === "latest" ? HEAD : parseInt(filter.fromBlock, 16);
        const to = filter.toBlock === undefined || filter.toBlock === "latest" ? HEAD : parseInt(filter.toBlock, 16);
        result =
          from <= EVENT_BLOCK && EVENT_BLOCK <= to
            ? [
                rawLog({
                  logIndex: 2,
                  blockNumber: EVENT_BLOCK,
                  blockHash: `0x${"AA".repeat(32)}`,
                  transactionHash: `0x${"BB".repeat(32)}`,
                }),
              ]
            : [];
      }
      if (rpc.method === "eth_getBlockByNumber") result = state.canonicalHash === null ? null : blockBody(state.canonicalHash);
      if (rpc.method === "eth_getTransactionReceipt") {
        result =
          state.receipt === "missing"
            ? null
            : {
                status: "0x1",
                blockHash: state.receiptBlockHash,
                blockNumber: `0x${EVENT_BLOCK.toString(16)}`,
                transactionHash: `0x${"BB".repeat(32)}`,
                transactionIndex: "0x1",
                from: WALLET,
                to: REGISTRY,
                cumulativeGasUsed: "0x1",
                gasUsed: "0x1",
                effectiveGasPrice: "0x1",
                contractAddress: null,
                logsBloom: `0x${"00".repeat(256)}`,
                type: "0x2",
                logs: [
                  {
                    address: REGISTRY,
                    topics: registeredTopics(WALLET, COMMITMENT),
                    data: registeredData(),
                    blockHash: state.receiptBlockHash,
                    blockNumber: `0x${EVENT_BLOCK.toString(16)}`,
                    transactionHash: `0x${"BB".repeat(32)}`,
                    transactionIndex: "0x1",
                    logIndex: "0x2",
                    removed: false,
                  },
                ],
              };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  node = { server, url: `http://127.0.0.1:${port}`, requests, state };
  return node;
}

afterEach(async () => {
  if (node !== undefined) await new Promise<void>((resolve) => node!.server.close(() => resolve()));
  node = undefined;
});

function serviceFor(stub: StubNode, repository: FakeWalletRegistrationRepository) {
  const chain = createChainClients({
    network: "base-sepolia",
    rpcUrl: stub.url,
    operatorPrivateKey: `0x${"11".repeat(32)}` as Hex,
    walletRegistryContractAddress: REGISTRY,
  });
  return new ConfirmWalletRegistrationsService(repository, chain, () => new Date("2026-11-13T12:00:00.000Z"));
}

const pendingRow = { accountId: "acct_01", walletAddress: WALLET, commitment: COMMITMENT };

describe("wallet registry event reading against a JSON-RPC node (real viem client)", () => {
  it("sends the block range with eth_getLogs, finds the event and stores its identity in lower case", async () => {
    const stub = await startNode();
    const repository = new FakeWalletRegistrationRepository([pendingRow], BigInt(EVENT_BLOCK - 10));

    const summary = await serviceFor(stub, repository).execute();

    const getLogs = stub.requests.filter((request) => request.method === "eth_getLogs");
    expect(getLogs).toHaveLength(1);
    expect(getLogs[0]!.params[0]).toMatchObject({
      fromBlock: `0x${(EVENT_BLOCK - 10 - 31).toString(16)}`,
      toBlock: `0x${(HEAD - 3).toString(16)}`,
    });
    expect(summary).toMatchObject({ eventsFound: 1, registrationsConfirmed: 1, unmatchedEvents: 0 });
    expect(repository.row("acct_01")).toMatchObject({
      transactionHash: hexHash("bb"),
      blockHash: hexHash("aa"),
      blockNumber: BigInt(EVENT_BLOCK),
      logIndex: 2,
    });
  });

  it("re-checks a confirmation against the node with the real reader and flags it when the transaction is gone", async () => {
    const stub = await startNode();
    const repository = new FakeWalletRegistrationRepository([pendingRow], BigInt(EVENT_BLOCK - 10));
    const service = serviceFor(stub, repository);
    await service.execute();
    expect(repository.row("acct_01").flag).toBeNull();

    // The block at that height is now another block, and the transaction is not on the chain.
    stub.state.canonicalHash = `0x${"CC".repeat(32)}`;
    stub.state.receipt = "missing";
    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRechecked: 1, evidenceFlagged: 1, evidenceRecheckErrors: 0 });
    expect(repository.row("acct_01")).toMatchObject({ flag: "transaction_missing" });
    expect(repository.row("acct_01").registeredAt).not.toBeNull();
    expect(summary.cursorRewoundTo).toBe((EVENT_BLOCK - 1).toString());
  });

  it("refreshes the evidence with the real reader when the transaction was mined again in another block", async () => {
    const stub = await startNode();
    const repository = new FakeWalletRegistrationRepository([pendingRow], BigInt(EVENT_BLOCK - 10));
    const service = serviceFor(stub, repository);
    await service.execute();

    stub.state.canonicalHash = `0x${"CC".repeat(32)}`;
    stub.state.receiptBlockHash = `0x${"CC".repeat(32)}`;
    const summary = await service.execute();

    expect(summary).toMatchObject({ evidenceRefreshed: 1, evidenceFlagged: 0 });
    expect(repository.row("acct_01").blockHash).toBe(hexHash("cc"));
  });
});
