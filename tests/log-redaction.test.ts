import { HttpRequestError } from "viem";
import { describe, expect, it } from "vitest";

import { maskHexIdentifier, stripUrls, toSanitizedError } from "../src/shared/logging/log-redaction.js";

const RPC_SECRET = "SECRETPROVIDERKEY123";
const RPC_URL = `https://base-sepolia.g.alchemy.com/v2/${RPC_SECRET}`;

const ADDRESS = "0xAbCdEf0123456789aBcDeF0123456789abcdef01";
const COMMITMENT = `0x${"ab12".repeat(16)}`;

describe("maskHexIdentifier", () => {
  it("masks a 40-hex address to its first six and last four characters, lower-cased", () => {
    expect(maskHexIdentifier(ADDRESS)).toBe("0xabcd...ef01");
  });

  it("masks a 64-hex commitment the same way", () => {
    expect(maskHexIdentifier(COMMITMENT)).toBe("0xab12...ab12");
  });

  it("treats mixed case and the same value in another case as one masked form", () => {
    expect(maskHexIdentifier(ADDRESS.toUpperCase().replace("0X", "0x"))).toBe(maskHexIdentifier(ADDRESS));
  });

  it("trims surrounding whitespace and accepts an upper-case 0X prefix", () => {
    expect(maskHexIdentifier(`  0X${ADDRESS.slice(2)}\n`)).toBe("0xabcd...ef01");
  });

  it("never echoes anything that is not a plausible hex identifier", () => {
    for (const value of ["not hex at all", "0x12", "0xzzzzzzzzzzzz", "", "   ", null, undefined, 42, {}, ["0xabcdef0123"]]) {
      expect(maskHexIdentifier(value)).toBe("[invalid]");
    }
  });

  it("never lets the original value through", () => {
    const masked = maskHexIdentifier(ADDRESS);
    expect(masked).not.toContain(ADDRESS.slice(6, 38));
    expect(masked.length).toBeLessThan(ADDRESS.length / 2);
  });
});

describe("stripUrls", () => {
  it("strips the RPC URL out of a real viem HttpRequestError message and keeps the rest", () => {
    const error = new HttpRequestError({ url: RPC_URL, body: { method: "eth_getLogs" }, details: "fetch failed" });
    // Guards the premise of this suite: viem really does put the URL into the message.
    expect(error.message).toContain(RPC_SECRET);

    const stripped = stripUrls(error.message);

    expect(stripped).not.toContain(RPC_SECRET);
    expect(stripped).toContain("URL: [url]");
    expect(stripped).toContain("fetch failed");
  });

  it("strips websocket, database and upper-case-scheme URLs, including userinfo and query strings", () => {
    expect(stripUrls("GET wss://rpc.example.org/ws?apikey=abc&x=1 timed out")).toBe("GET [url] timed out");
    expect(stripUrls("postgresql://user:pw@db:5432/x refused")).toBe("[url] refused");
    expect(stripUrls("HTTPS://Example.org/Path/KEY failed")).toBe("[url] failed");
  });

  it("strips several URLs in one string", () => {
    expect(stripUrls(`a ${RPC_URL} b http://10.0.0.1:8545/key c`)).toBe("a [url] b [url] c");
  });

  it("stops at a quote or a closing bracket so surrounding text survives", () => {
    expect(stripUrls(`(see ${RPC_URL}) and "${RPC_URL}" and [${RPC_URL}]`)).toBe('(see [url]) and "[url]" and [[url]]');
  });

  it("leaves a host:port without a scheme untouched", () => {
    const text = "connect ECONNREFUSED 10.0.0.1:5432";
    expect(stripUrls(text)).toBe(text);
  });

  it("leaves file:// stack frames untouched", () => {
    const text = "    at run (file:///app/dist/worker.js:12:3)";
    expect(stripUrls(text)).toBe(text);
  });

  it("passes text without a URL through unchanged and is idempotent", () => {
    expect(stripUrls("no urls here")).toBe("no urls here");
    const once = stripUrls(`x ${RPC_URL} y`);
    expect(stripUrls(once)).toBe(once);
  });
});

describe("toSanitizedError", () => {
  function leakyViemError(): HttpRequestError {
    const error = new HttpRequestError({ url: RPC_URL, body: { method: "eth_getLogs" }, details: "fetch failed" });
    return Object.assign(error, { cause: new Error(`inner ${RPC_URL}`) });
  }

  it("keeps the name and strips the URL from the message and the stack", () => {
    const original = leakyViemError();
    // Premise: the original really carries the secret in all of these places.
    expect(original.message).toContain(RPC_SECRET);
    expect(original.stack).toContain(RPC_SECRET);
    expect(JSON.stringify(original)).toContain(RPC_SECRET);

    const sanitized = toSanitizedError(original);

    expect(sanitized).toBeInstanceOf(Error);
    expect(sanitized.name).toBe("HttpRequestError");
    expect(sanitized.message).not.toContain(RPC_SECRET);
    expect(sanitized.stack).not.toContain(RPC_SECRET);
    expect(sanitized.message).toContain("fetch failed");
  });

  it("carries no cause and no own properties, so serialising it cannot reach the URL", () => {
    const sanitized = toSanitizedError(leakyViemError());

    expect(sanitized.cause).toBeUndefined();
    // `name` is the only own property; url, headers, body and the like are gone.
    expect(Object.keys(sanitized).filter((key) => key !== "name")).toEqual([]);
    expect(JSON.stringify(sanitized)).not.toContain(RPC_SECRET);
    expect(JSON.stringify({ ...sanitized, message: sanitized.message, stack: sanitized.stack })).not.toContain(RPC_SECRET);
  });

  it("wraps a thrown string or any other non-Error value without echoing an object", () => {
    expect(toSanitizedError(`failed at ${RPC_URL}`).message).toBe("failed at [url]");
    expect(toSanitizedError({ url: RPC_URL }).message).toBe("non-error value thrown");
    expect(toSanitizedError(undefined).message).toBe("non-error value thrown");
  });
});
