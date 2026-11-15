import {
  HttpRequestError,
  createPublicClient,
  custom,
  decodeFunctionData,
  getAddress,
  multicall3Abi,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";

import vistaBloxPropertyAbi from "../src/infrastructure/blockchain/abis/VistaBloxProperty.abi.json" with { type: "json" };
import { ChainReader } from "../src/infrastructure/blockchain/chain-client.js";
import {
  classifyRevert,
  readTransferSnapshot,
  type TransferSnapshotDeps,
} from "../src/infrastructure/blockchain/transfer-snapshot.js";
import { ChainStateUnavailableError } from "../src/shared/errors/chain-state-unavailable-error.js";
import {
  BAD_STATE,
  GOOD_STATE,
  PROPERTY_ADDRESS,
  RECIPIENT_ADDRESS,
  REVERT_SHAPES,
  RPC_URL_WITH_KEY,
  WALLET_ADDRESS,
  blockHash,
  createTransferWorld,
  revertData,
  rpcFailure,
  type TransferWorld,
  type WorldBlockState,
} from "./support/transfer-chain-world.js";

const HEAD_A = blockHash("a1");
const HEAD_B = blockHash("b2");

const input = { from: WALLET_ADDRESS, to: RECIPIENT_ADDRESS, tokenId: "7", amount: "3" };

// The same encoder production uses, so "the bytes that are simulated are the
// bytes that are returned" is checked against the real calldata.
const reader = new ChainReader({
  network: "base-sepolia",
  rpcUrl: "https://rpc.example.test",
  propertyContractAddress: PROPERTY_ADDRESS,
  eurcTokenAddress: "0x2222222222222222222222222222222222222222",
});

function depsFor(world: TransferWorld, overrides: Partial<TransferSnapshotDeps> = {}): TransferSnapshotDeps {
  return {
    client: createPublicClient({
      chain: baseSepolia,
      transport: custom({ request: (args: { method: string; params?: unknown }) => world.request(args) }, { retryCount: 0 }),
    }),
    propertyAddress: PROPERTY_ADDRESS,
    chainId: baseSepolia.id,
    encodeTransferCalldata: (calldataInput) => reader.encodeTransferCalldata(calldataInput),
    ...overrides,
  };
}

function callsTo(world: TransferWorld, address: string) {
  return world.calls
    .filter((call) => call.method === "eth_call")
    .map((call) => call.params as [Record<string, string>, unknown])
    .filter(([tx]) => tx.to?.toLowerCase() === address.toLowerCase());
}

const MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11";

// viem decodes addresses to EIP-55 checksum form; the wire carries lowercase.
function lowercaseAddresses(values: readonly unknown[]): unknown[] {
  return values.map((value) =>
    typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value,
  );
}

// An address viem's strict validation rejects: valid hex, wrong EIP-55 casing.
function withBrokenChecksum(address: string): string {
  const checksummed = getAddress(address);
  const index = checksummed.slice(2).search(/[a-fA-F]/) + 2;
  const flipped = checksummed[index] === checksummed[index]!.toUpperCase()
    ? checksummed[index]!.toLowerCase()
    : checksummed[index]!.toUpperCase();
  return `${checksummed.slice(0, index)}${flipped}${checksummed.slice(index + 1)}`;
}

function worldWith(states: Record<Hex, WorldBlockState>, head: Hex = HEAD_A, latest?: WorldBlockState) {
  return createTransferWorld({ head, states, ...(latest === undefined ? {} : { latest }) });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readTransferSnapshot", () => {
  it("reads the head once and pins the reads and the simulation to that block hash", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(world.calls.map((call) => call.method).sort()).toEqual([
      "eth_call",
      "eth_call",
      "eth_getBlockByNumber",
    ]);
    expect(world.calls.find((call) => call.method === "eth_getBlockByNumber")?.params).toEqual(["latest", false]);
    for (const [, block] of [...callsTo(world, MULTICALL), ...callsTo(world, PROPERTY_ADDRESS)]) {
      expect(block).toEqual({ blockHash: HEAD_A, requireCanonical: true });
    }
    expect(callsTo(world, MULTICALL)).toHaveLength(1);
    expect(callsTo(world, PROPERTY_ADDRESS)).toHaveLength(1);
    expect(snapshot.block).toEqual({ number: 1000n, hash: HEAD_A });
    expect(snapshot).toMatchObject({
      senderBalance: 10n,
      recipientAuthorized: true,
      tokenPaused: false,
      simulation: { status: "passed" },
    });
  });

  it("reads balance, recipient authorization and token pause in one Multicall3 call", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });

    await readTransferSnapshot(depsFor(world), input);

    const [[tx]] = callsTo(world, MULTICALL) as [[Record<string, string>, unknown]];
    const aggregate = decodeFunctionData({ abi: multicall3Abi, data: tx!.data as Hex });
    const subcalls = (aggregate.args as readonly [readonly { target: string; callData: Hex }[]])[0];
    const decoded = subcalls.map((subcall) => {
      const call = decodeFunctionData({ abi: vistaBloxPropertyAbi, data: subcall.callData });
      return {
        target: subcall.target.toLowerCase(),
        functionName: call.functionName,
        args: lowercaseAddresses(call.args ?? []),
      };
    });
    expect(decoded).toEqual([
      { target: PROPERTY_ADDRESS, functionName: "balanceOf", args: [WALLET_ADDRESS, 7n] },
      { target: PROPERTY_ADDRESS, functionName: "isHolderAuthorized", args: [RECIPIENT_ADDRESS, 7n] },
      { target: PROPERTY_ADDRESS, functionName: "isTokenPaused", args: [7n] },
    ]);
  });

  it("returns the state of the pinned block, not of whatever 'latest' is at call time", async () => {
    // Head A is healthy; an unpinned read would see B (empty, unauthorized, paused, lane closed).
    const world = worldWith({ [HEAD_A]: GOOD_STATE }, HEAD_A, BAD_STATE);

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot.senderBalance).toBe(10n);
    expect(snapshot.recipientAuthorized).toBe(true);
    expect(snapshot.tokenPaused).toBe(false);
    expect(snapshot.simulation).toEqual({ status: "passed" });
  });

  it("returns a bad pinned state even when 'latest' has since become good", async () => {
    const world = worldWith({ [HEAD_A]: BAD_STATE }, HEAD_A, GOOD_STATE);

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot).toMatchObject({
      senderBalance: 0n,
      recipientAuthorized: false,
      tokenPaused: true,
      simulation: { status: "reverted", revert: { errorName: "TransferLaneClosed" } },
    });
  });

  it("simulates exactly the calldata it returns, from the sender, against the property contract", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    const [[tx]] = callsTo(world, PROPERTY_ADDRESS) as [[Record<string, string>, unknown]];
    expect(tx!.data).toBe(snapshot.unsignedTransaction.data);
    expect(tx!.from).toBe(WALLET_ADDRESS);
    expect(tx!.to?.toLowerCase()).toBe(PROPERTY_ADDRESS);
    expect(snapshot.unsignedTransaction).toEqual({
      chainId: baseSepolia.id,
      to: PROPERTY_ADDRESS,
      data: tx!.data,
      value: "0",
    });
    expect(snapshot.unsignedTransaction.data.startsWith("0xf242432a")).toBe(true);
    const decoded = decodeFunctionData({ abi: vistaBloxPropertyAbi, data: tx!.data as Hex });
    expect(decoded.functionName).toBe("safeTransferFrom");
    expect(lowercaseAddresses(decoded.args ?? [])).toEqual([WALLET_ADDRESS, RECIPIENT_ADDRESS, 7n, 3n, "0x"]);
  });

  it("returns the same calldata the route's own encoder produces for the same input", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot.unsignedTransaction.data).toBe(
      reader.encodeTransferCalldata({
        from: WALLET_ADDRESS,
        to: RECIPIENT_ADDRESS,
        tokenId: 7n,
        amount: 3n,
      }),
    );
  });

  it("takes a fresh head on every call, so a moved head is never served from a client cache", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE, [HEAD_B]: { ...GOOD_STATE, balance: 99n } });
    const deps = depsFor(world);

    const first = await readTransferSnapshot(deps, input);
    world.head = HEAD_B;
    const second = await readTransferSnapshot(deps, input);

    expect(first.block.hash).toBe(HEAD_A);
    expect(first.senderBalance).toBe(10n);
    expect(second.block.hash).toBe(HEAD_B);
    expect(second.senderBalance).toBe(99n);
    expect(world.calls.some((call) => call.method === "eth_blockNumber")).toBe(false);
    expect(callsTo(world, PROPERTY_ADDRESS).map(([, block]) => block)).toEqual([
      { blockHash: HEAD_A, requireCanonical: true },
      { blockHash: HEAD_B, requireCanonical: true },
    ]);
  });

  it("keeps two concurrent calls with different heads independent", async () => {
    const stateA = { ...GOOD_STATE, balance: 11n };
    const stateB = { ...GOOD_STATE, balance: 22n, tokenPaused: true };
    const world = worldWith({ [HEAD_A]: stateA, [HEAD_B]: stateB });
    // First request for the head sees A, the next one sees B.
    const heads = [HEAD_A, HEAD_B];
    world.headResponse = () => ({ number: "0x3e8", hash: heads.shift(), transactions: [] });
    const deps = depsFor(world);

    const [first, second] = await Promise.all([
      readTransferSnapshot(deps, input),
      readTransferSnapshot(deps, { ...input, amount: "4" }),
    ]);

    expect(first.block.hash).toBe(HEAD_A);
    expect(first).toMatchObject({ senderBalance: 11n, tokenPaused: false });
    expect(second.block.hash).toBe(HEAD_B);
    expect(second).toMatchObject({ senderBalance: 22n, tokenPaused: true });
  });

  it("gives identical snapshots for the same head read twice", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    const deps = depsFor(world);

    expect(await readTransferSnapshot(deps, input)).toEqual(await readTransferSnapshot(deps, input));
  });

  it.each([
    [
      "all-uppercase",
      `0x${WALLET_ADDRESS.slice(2).toUpperCase()}`,
      `0x${RECIPIENT_ADDRESS.slice(2).toUpperCase()}`,
    ],
    ["bad-checksum mixed-case", withBrokenChecksum(WALLET_ADDRESS), withBrokenChecksum(RECIPIENT_ADDRESS)],
    ["whitespace-padded", ` ${WALLET_ADDRESS} `, ` ${RECIPIENT_ADDRESS}\n`],
  ])("accepts %s legacy addresses and encodes the same calldata as lowercase", async (_name, from, to) => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });

    const lower = await readTransferSnapshot(depsFor(worldWith({ [HEAD_A]: GOOD_STATE })), input);
    const snapshot = await readTransferSnapshot(depsFor(world), { ...input, from, to });

    expect(snapshot.unsignedTransaction.data).toBe(lower.unsignedTransaction.data);
    const [[tx]] = callsTo(world, PROPERTY_ADDRESS) as [[Record<string, string>, unknown]];
    expect(tx!.from).toBe(WALLET_ADDRESS);
  });

  it("does not wrap a calldata error that happens before the chain is touched", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });

    const error = await readTransferSnapshot(depsFor(world), { ...input, to: "not-an-address" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ChainStateUnavailableError);
    expect(world.calls).toHaveLength(0);
  });
});

describe("readTransferSnapshot revert classification", () => {
  type Expected = { errorName?: string; reason?: string };
  const cases: [string, keyof typeof REVERT_SHAPES, Hex | undefined, string | undefined, Expected][] = [
    ["code 3 with a custom error", "code 3 with data", revertData("TransferLaneClosed"), undefined, { errorName: "TransferLaneClosed" }],
    ["code -32000 with a custom error", "code -32000 with data", revertData("HolderNotAuthorized", [7n, RECIPIENT_ADDRESS]), undefined, { errorName: "HolderNotAuthorized" }],
    ["nested data.data", "nested data.data", revertData("TokenIsPaused", [7n]), undefined, { errorName: "TokenIsPaused" }],
    ["Error(string) with a reason", "reason text with data", revertData("Error", ["nope"]), "nope", { errorName: "Error", reason: "nope" }],
    ["Panic(uint256)", "code 3 with data", revertData("Panic", [17n]), undefined, { errorName: "Panic" }],
    ["a bare revert without data", "code 3 with data", undefined, undefined, {}],
    ["an unknown selector", "code 3 with data", "0xdeadbeef", undefined, {}],
  ];

  it.each(cases)("reports %s as a simulation revert, not an outage", async (_name, shape, data, reason, expected) => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    world.simulationFailure = () => {
      throw rpcFailure(REVERT_SHAPES[shape]!(data, reason));
    };

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot.simulation).toEqual({ status: "reverted", revert: expected });
    // The reads still came back, from the same block.
    expect(snapshot.senderBalance).toBe(10n);
  });
});

describe("readTransferSnapshot infrastructure failures", () => {
  const failures: [string, (world: TransferWorld) => void][] = [
    [
      "a JSON-RPC internal error on the simulation",
      (world) => {
        world.simulationFailure = () => {
          throw rpcFailure({ code: -32603, message: "internal error" });
        };
      },
    ],
    [
      "header not found on the simulation",
      (world) => {
        world.simulationFailure = () => {
          throw rpcFailure({ code: -32000, message: "header not found" });
        };
      },
    ],
    [
      "resource not found on the simulation",
      (world) => {
        world.simulationFailure = () => {
          throw rpcFailure({ code: -32001, message: "resource not found" });
        };
      },
    ],
    [
      "an HTTP failure on the head read",
      (world) => {
        world.headResponse = () => {
          throw new HttpRequestError({ url: RPC_URL_WITH_KEY, status: 502 });
        };
      },
    ],
    [
      "a revert on the Multicall3 read",
      (world) => {
        world.multicallFailure = () => {
          throw rpcFailure({ code: 3, message: "execution reverted", data: revertData("EnforcedPause") });
        };
      },
    ],
    [
      "an internal error on the Multicall3 read",
      (world) => {
        world.multicallFailure = () => {
          throw rpcFailure({ code: -32603, message: "internal error" });
        };
      },
    ],
    [
      "a malformed Multicall3 result",
      (world) => {
        world.multicallResult = () => "0x1234";
      },
    ],
    [
      "a head with no hash (a pending block)",
      (world) => {
        world.headResponse = () => ({ number: "0x3e8", hash: null, transactions: [] });
      },
    ],
    [
      "a head with no number",
      (world) => {
        world.headResponse = () => ({ number: null, hash: HEAD_A, transactions: [] });
      },
    ],
    [
      "a pinned block that is no longer canonical",
      (world) => {
        world.nonCanonical.add(HEAD_A);
      },
    ],
    [
      "a pinned block the node does not know",
      (world) => {
        world.states.delete(HEAD_A);
      },
    ],
  ];

  it.each(failures)("throws ChainStateUnavailableError for %s", async (_name, arrange) => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    arrange(world);

    const error = await readTransferSnapshot(depsFor(world), input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
  });

  it("keeps the reason for a head with no hash or number, not an anonymous 'Error'", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    world.headResponse = () => ({ number: "0x3e8", hash: null, transactions: [] });

    const error = (await readTransferSnapshot(depsFor(world), input).catch((caught: unknown) => caught)) as Error;

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    expect(error.message).toBe("latest block has no number or hash");
  });

  it.each(failures)("leaks neither the RPC URL nor its key for %s", async (_name, arrange) => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    arrange(world);

    const error = (await readTransferSnapshot(depsFor(world), input).catch((caught: unknown) => caught)) as Error;

    const everything = [error.name, error.message, error.stack ?? "", JSON.stringify(error), String(error.cause)].join("\n");
    expect(everything).not.toMatch(/SECRET-API-KEY|rpc\.example\.test|https?:\/\//);
    expect(error.cause).toBeUndefined();
  });

  it("gives up after the budget when the node hangs, and swallows the late rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const world = worldWith({ [HEAD_A]: GOOD_STATE });
      // Hangs past the budget, then fails: the abandoned attempt must not surface.
      world.headResponse = () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(rpcFailure({ code: -32603, message: "late failure" })), 300);
        });
      const started = Date.now();

      const error = await readTransferSnapshot(depsFor(world, { budgetMs: 100 }), input).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(ChainStateUnavailableError);
      expect(Date.now() - started).toBeLessThan(280);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

// What an operator can learn from the description alone, when the request
// answers 503. It must say which kind of failure it was without ever carrying
// the node's own message (a node can echo the request path, which holds the key).
describe("readTransferSnapshot failure description", () => {
  async function describeFailure(arrange: (world: TransferWorld) => void): Promise<string> {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    arrange(world);
    const error = (await readTransferSnapshot(depsFor(world), input).catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    return error.message;
  }

  const rpcCodes: [string, number, string][] = [
    ["a provider that rejects EIP-1898 block hashes", -32602, "node-words: blockHash not supported"],
    ["a header the node does not have", -32000, "node-words: header not found"],
    ["an internal error", -32603, "node-words: boom"],
    ["a rate limit", -32005, "node-words: slow down"],
  ];

  it.each(rpcCodes)("names the JSON-RPC code for %s", async (_name, code, nodeMessage) => {
    const message = await describeFailure((world) => {
      world.simulationFailure = () => {
        throw rpcFailure({ code, message: nodeMessage });
      };
    });

    expect(message).toContain(`code ${code}`);
    // The node's own words are not part of the description: they can echo the URL.
    expect(message).not.toContain(nodeMessage);
  });

  it("names the HTTP status of a failed request", async () => {
    const message = await describeFailure((world) => {
      world.headResponse = () => {
        throw new HttpRequestError({ url: RPC_URL_WITH_KEY, status: 429 });
      };
    });

    expect(message).toContain("status 429");
    expect(message).not.toMatch(/SECRET-API-KEY|rpc\.example\.test|https?:\/\//);
  });

  it("does not let a node smuggle its message in through a JSON-RPC error", async () => {
    const message = await describeFailure((world) => {
      world.simulationFailure = () => {
        throw rpcFailure({ code: -32603, message: `internal error at ${RPC_URL_WITH_KEY}` });
      };
    });

    expect(message).not.toMatch(/SECRET-API-KEY|rpc\.example\.test|https?:\/\//);
  });

  it("tells a provider that rejects block hashes apart from a header it does not have", async () => {
    const rejected = await describeFailure((world) => {
      world.simulationFailure = () => {
        throw rpcFailure({ code: -32602, message: "invalid argument 1" });
      };
    });
    const missing = await describeFailure((world) => {
      world.simulationFailure = () => {
        throw rpcFailure({ code: -32000, message: "header not found" });
      };
    });

    expect(rejected).not.toBe(missing);
  });
});

// A load-balanced provider can answer the pinned calls from a backend that has
// not imported the head the first backend just reported (or whose head was
// reorged away). viem's transport does not retry that family, so one bounded
// retry of the whole snapshot (head included) is made, inside the same budget.
describe("readTransferSnapshot lagging backend", () => {
  // Reports `heads` one per getBlock call, the last one repeated.
  function reportHeads(world: TransferWorld, heads: Hex[]) {
    let reads = 0;
    world.headResponse = () => ({
      number: "0x3e8",
      hash: heads[Math.min(reads++, heads.length - 1)],
      transactions: [],
    });
  }
  const headReads = (world: TransferWorld) => world.calls.filter((call) => call.method === "eth_getBlockByNumber").length;

  it("re-reads the head once when the pinned block is not known yet, and answers from the new one", async () => {
    // HEAD_B is the head the first backend reported; the backend that served
    // the pinned calls only knows HEAD_A.
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    reportHeads(world, [HEAD_B, HEAD_A]);

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot.block.hash).toBe(HEAD_A);
    expect(headReads(world)).toBe(2);
    // Every call of the second attempt is pinned to the second head.
    const pins = world.calls
      .filter((call) => call.method === "eth_call")
      .map((call) => (call.params as [unknown, { blockHash: Hex }])[1].blockHash);
    expect(pins.slice(-2)).toEqual([HEAD_A, HEAD_A]);
  });

  it("re-reads the head once when the pinned block is no longer canonical", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE, [HEAD_B]: GOOD_STATE });
    world.nonCanonical.add(HEAD_B);
    reportHeads(world, [HEAD_B, HEAD_A]);

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot.block.hash).toBe(HEAD_A);
    expect(headReads(world)).toBe(2);
  });

  // The words are each client's own; the retry must recognise the ones real
  // nodes use for "I cannot serve that block hash right now".
  it.each([
    ["geth, unknown hash", { code: -32000, message: "header for hash not found" }],
    ["geth, hash reorged away", { code: -32000, message: "hash is not currently canonical" }],
    ["a node reporting an unknown block", { code: -32000, message: "unknown block" }],
    ["a node reporting header not found", { code: -32000, message: "header not found" }],
    ["EIP-1474 resource not found", { code: -32001, message: "Resource not found" }],
  ])("re-reads the head once on %s", async (_name, failure) => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    let simulations = 0;
    // Only the first simulation fails; the world answers the second normally.
    world.simulationFailure = () => {
      simulations += 1;
      if (simulations === 1) {
        throw rpcFailure(failure);
      }
      return undefined as never;
    };

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot.simulation).toEqual({ status: "passed" });
    expect(headReads(world)).toBe(2);
  });

  it("gives up after the second attempt and reports an outage", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    reportHeads(world, [HEAD_B]);

    const error = await readTransferSnapshot(depsFor(world), input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    expect(headReads(world)).toBe(2);
  });

  it.each([
    ["a JSON-RPC internal error", { code: -32603, message: "internal error" }],
    ["a provider that rejects block hashes", { code: -32602, message: "invalid argument 1: blockHash not supported" }],
    ["a rate limit", { code: -32005, message: "limit exceeded" }],
    ["an unrelated -32000", { code: -32000, message: "execution timeout" }],
  ])("does not retry %s", async (_name, failure) => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    world.simulationFailure = () => {
      throw rpcFailure(failure);
    };

    const error = await readTransferSnapshot(depsFor(world), input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    expect(headReads(world)).toBe(1);
  });

  it("does not retry a contract revert, which is an answer", async () => {
    const world = worldWith({ [HEAD_A]: BAD_STATE });
    world.simulationFailure = () => {
      throw rpcFailure(REVERT_SHAPES["code 3 with data"]!(revertData("TransferLaneClosed")));
    };

    const snapshot = await readTransferSnapshot(depsFor(world), input);

    expect(snapshot.simulation).toEqual({ status: "reverted", revert: { errorName: "TransferLaneClosed" } });
    expect(headReads(world)).toBe(1);
  });

  it("does not retry a head with no hash", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    world.headResponse = () => ({ number: "0x3e8", hash: null, transactions: [] });

    await readTransferSnapshot(depsFor(world), input).catch(() => undefined);

    expect(headReads(world)).toBe(1);
  });

  it("spends the same budget on both attempts, not one budget each", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    let reads = 0;
    // First attempt: a slow head that turns out to be unknown. Second: hangs.
    world.headResponse = () => {
      reads += 1;
      if (reads === 1) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ number: "0x3e8", hash: HEAD_B, transactions: [] }), 60);
        });
      }
      return new Promise(() => undefined);
    };
    const started = Date.now();

    const error = await readTransferSnapshot(depsFor(world, { budgetMs: 100 }), input).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    expect(reads).toBe(2);
    expect(Date.now() - started).toBeLessThan(180);
  });

  it("does not start a second attempt once the budget has run out", async () => {
    const world = worldWith({ [HEAD_A]: GOOD_STATE });
    // The head arrives after the budget, and is unknown: no retry may follow.
    world.headResponse = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ number: "0x3e8", hash: HEAD_B, transactions: [] }), 150);
      });

    const error = await readTransferSnapshot(depsFor(world, { budgetMs: 50 }), input).catch(
      (caught: unknown) => caught,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(error).toBeInstanceOf(ChainStateUnavailableError);
    expect(headReads(world)).toBe(1);
  });
});

describe("classifyRevert", () => {
  it("does not treat a non-viem error as a revert", () => {
    expect(classifyRevert(new Error("execution reverted"))).toBeUndefined();
    expect(classifyRevert("execution reverted")).toBeUndefined();
    expect(classifyRevert(undefined)).toBeUndefined();
  });
});
