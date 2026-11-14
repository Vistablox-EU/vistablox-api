import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  RpcRequestError,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  multicall3Abi,
  parseAbi,
  toHex,
  type Hex,
} from "viem";

import vistaBloxPropertyAbi from "../../src/infrastructure/blockchain/abis/VistaBloxProperty.abi.json" with { type: "json" };

/**
 * A tiny EIP-1193 chain whose state depends on the block an eth_call is
 * pinned to. Blocks are keyed by hash, plus a separate `latest` state that is
 * what an UNPINNED call would see: any code path that forgets to pin its
 * calls reads `latest` and the state-read consistency tests catch it.
 */
export const PROPERTY_ADDRESS = "0x1111111111111111111111111111111111111111";
export const MULTICALL3_ADDRESS = "0xca11bde05977b3631167028862be2a173976ca11";
export const WALLET_ADDRESS = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
export const RECIPIENT_ADDRESS = "0x00000000219ab540356cbb839cbe05303d7705fa";
export const RPC_URL_WITH_KEY = "https://rpc.example.test/v2/SECRET-API-KEY-123";

export interface WorldBlockState {
  balance: bigint;
  recipientAuthorized: boolean;
  tokenPaused: boolean;
  // closed: safeTransferFrom always reverts TransferLaneClosed (Phase 1).
  // open: it checks pause, authorization and balance like an open lane would.
  lane: "closed" | "open";
}

export const GOOD_STATE: WorldBlockState = {
  balance: 10n,
  recipientAuthorized: true,
  tokenPaused: false,
  lane: "open",
};

export const BAD_STATE: WorldBlockState = {
  balance: 0n,
  recipientAuthorized: false,
  tokenPaused: true,
  lane: "closed",
};

export const blockHash = (tag: string): Hex => `0x${tag.repeat(32).slice(0, 64)}`;

type RpcFailure = { code: number; message: string; data?: unknown };
// How an eth_call to the property contract that reverts is reported.
export type RevertShape = (revertData: Hex | undefined, reason?: string) => RpcFailure;

export const REVERT_SHAPES: Record<string, RevertShape> = {
  "code 3 with data": (data) => ({ code: 3, message: "execution reverted", ...(data ? { data } : {}) }),
  "code -32000 with data": (data) => ({ code: -32000, message: "execution reverted", ...(data ? { data } : {}) }),
  "reason text with data": (data, reason) => ({
    code: 3,
    message: reason === undefined ? "execution reverted" : `execution reverted: ${reason}`,
    ...(data ? { data } : {}),
  }),
  "nested data.data": (data) => ({
    code: 3,
    message: "execution reverted",
    ...(data ? { data: { data } } : {}),
  }),
};

const revertAbi = [...vistaBloxPropertyAbi, ...parseAbi(["error Error(string message)", "error Panic(uint256 code)"])] as const;

export function revertData(errorName: string, args: readonly unknown[] = []): Hex {
  return encodeErrorResult({ abi: revertAbi, errorName, args } as never);
}

export interface RecordedCall {
  method: string;
  params: unknown;
}

export function rpcFailure(failure: RpcFailure, url = RPC_URL_WITH_KEY): RpcRequestError {
  return new RpcRequestError({ body: { method: "eth_call" }, error: failure, url });
}

export interface TransferWorld {
  calls: RecordedCall[];
  // Hash the next eth_getBlockByNumber('latest') reports. Mutable.
  head: Hex;
  // State at each known block hash.
  states: Map<Hex, WorldBlockState>;
  // What an eth_call WITHOUT a block hash pin would see.
  latest: WorldBlockState;
  // Hashes that exist but are not canonical.
  nonCanonical: Set<Hex>;
  // Optional answer overrides for fault injection.
  headResponse?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  multicallFailure?: () => never;
  multicallResult?: () => Hex;
  simulationFailure?: (state: WorldBlockState) => never;
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

export function createTransferWorld(init: {
  head: Hex;
  states: Record<Hex, WorldBlockState>;
  latest?: WorldBlockState;
}): TransferWorld {
  function handleCall([tx, block]: [Record<string, string>, unknown]): Hex {
    const state = resolveState(world, block);
    const to = tx.to?.toLowerCase();
    if (to === MULTICALL3_ADDRESS) {
      if (world.multicallFailure !== undefined) world.multicallFailure();
      if (world.multicallResult !== undefined) return world.multicallResult();
      return answerMulticall(tx.data as Hex, state);
    }
    if (to === PROPERTY_ADDRESS) {
      if (world.simulationFailure !== undefined) world.simulationFailure(state);
      return simulateTransfer(tx, state);
    }
    throw rpcFailure({ code: -32000, message: `call to unexpected address ${to}` });
  }

  const world: TransferWorld = {
    calls: [],
    head: init.head,
    states: new Map(Object.entries(init.states) as [Hex, WorldBlockState][]),
    latest: init.latest ?? BAD_STATE,
    nonCanonical: new Set(),
    async request({ method, params }) {
      world.calls.push({ method, params });
      switch (method) {
        case "eth_getBlockByNumber":
          if (world.headResponse !== undefined) return world.headResponse();
          return { number: toHex(1000), hash: world.head, transactions: [] };
        case "eth_call":
          return handleCall(params as [Record<string, string>, unknown]);
        default:
          throw rpcFailure({ code: -32601, message: `unexpected method ${method}` });
      }
    },
  };
  return world;
}

function resolveState(world: TransferWorld, block: unknown): WorldBlockState {
  if (typeof block === "object" && block !== null && "blockHash" in block) {
    const { blockHash: hash, requireCanonical } = block as { blockHash: Hex; requireCanonical?: boolean };
    const state = world.states.get(hash);
    if (state === undefined) {
      throw rpcFailure({ code: -32001, message: "block not found" });
    }
    if (requireCanonical === true && world.nonCanonical.has(hash)) {
      throw rpcFailure({ code: -32000, message: "hash is not currently canonical" });
    }
    return state;
  }
  // Unpinned (a block tag or number): this is the trap.
  return world.latest;
}

function answerMulticall(data: Hex, state: WorldBlockState): Hex {
  const { args } = decodeFunctionData({ abi: multicall3Abi, data });
  const calls = (args as readonly [readonly { target: string; callData: Hex }[]])[0];
  const results = calls.map((call) => {
    const decoded = decodeFunctionData({ abi: vistaBloxPropertyAbi, data: call.callData });
    const value = (() => {
      switch (decoded.functionName) {
        case "balanceOf":
          return state.balance;
        case "isHolderAuthorized":
          return state.recipientAuthorized;
        case "isTokenPaused":
          return state.tokenPaused;
        default:
          throw new Error(`unexpected multicall function ${decoded.functionName}`);
      }
    })();
    return {
      success: true,
      returnData: encodeFunctionResult({
        abi: vistaBloxPropertyAbi,
        functionName: decoded.functionName,
        result: value,
      } as never),
    };
  });
  return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
}

function simulateTransfer(tx: Record<string, string>, state: WorldBlockState): Hex {
  const decoded = decodeFunctionData({ abi: vistaBloxPropertyAbi, data: tx.data as Hex });
  if (decoded.functionName !== "safeTransferFrom") {
    throw new Error(`unexpected function ${decoded.functionName}`);
  }
  const [, , tokenId, amount] = decoded.args as readonly [string, string, bigint, bigint];
  const fail = (errorName: string, args: readonly unknown[] = []): never => {
    throw rpcFailure({ code: 3, message: "execution reverted", data: revertData(errorName, args) });
  };
  if (state.lane === "closed") return fail("TransferLaneClosed");
  if (state.tokenPaused) return fail("TokenIsPaused", [tokenId]);
  if (!state.recipientAuthorized) return fail("HolderNotAuthorized", [tokenId, RECIPIENT_ADDRESS]);
  if (amount > state.balance) {
    return fail("ERC1155InsufficientBalance", [tx.from, state.balance, amount, tokenId]);
  }
  return "0x";
}

/**
 * Serves a world as a real JSON-RPC-over-HTTP endpoint, so the production http
 * transport, the config wiring and the chain id are exercised. The server is
 * pushed onto `servers` for the caller's afterEach to close. Resolves to the
 * base URL.
 */
export async function serveTransferWorld(world: TransferWorld, servers: Server[]): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
        params: unknown;
      };
      world
        .request({ method: body.method, params: body.params })
        .then((result) => ({ jsonrpc: "2.0", id: body.id, result }))
        .catch((error: { code: number; message: string; data?: unknown }) => ({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: error.code, message: error.message, data: error.data },
        }))
        .then((payload) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(payload));
        });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
