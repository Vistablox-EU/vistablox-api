import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpAndroidAttestationRevocationList } from "../src/modules/auth/infrastructure/http-android-attestation-revocation-list.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("HttpAndroidAttestationRevocationList", () => {
  it("treats a serial in the entries as revoked, and one not in it as not revoked", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: { deadbeef: {} } }));
    vi.stubGlobal("fetch", fetchMock);
    const list = new HttpAndroidAttestationRevocationList();

    await expect(list.isRevoked("deadbeef")).resolves.toBe(true);
    await expect(list.isRevoked("cafebabe")).resolves.toBe(false);
  });

  it("fails closed (treats every serial as revoked) when the list was never successfully fetched", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const list = new HttpAndroidAttestationRevocationList();

    await expect(list.isRevoked("anything")).resolves.toBe(true);
  });

  it("passes an AbortSignal (a fetch timeout) to the revocation-list request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const list = new HttpAndroidAttestationRevocationList();

    await list.isRevoked("x");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("shares a single in-flight refresh across concurrent callers instead of firing one fetch per caller", async () => {
    let resolveFetch: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    const list = new HttpAndroidAttestationRevocationList();

    const first = list.isRevoked("a");
    const second = list.isRevoked("b");
    const third = list.isRevoked("c");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch!(jsonResponse({ entries: {} }));
    await Promise.all([first, second, third]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-fetch within the cache TTL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const list = new HttpAndroidAttestationRevocationList();

    await list.isRevoked("a");
    await list.isRevoked("b");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
