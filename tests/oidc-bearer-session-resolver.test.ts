import { describe, expect, it, vi } from "vitest";
import type Provider from "oidc-provider";

import { OidcBearerSessionResolver } from "../src/modules/auth/infrastructure/oidc-bearer-session.resolver.js";

function fakeProvider(find: ReturnType<typeof vi.fn>): Provider {
  return { AccessToken: { find } } as unknown as Provider;
}

describe("OidcBearerSessionResolver", () => {
  it("returns null when there is no Authorization header", async () => {
    const find = vi.fn();
    const resolver = new OidcBearerSessionResolver(fakeProvider(find));

    expect(await resolver.resolve({})).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it("returns null for a non-Bearer Authorization header", async () => {
    const find = vi.fn();
    const resolver = new OidcBearerSessionResolver(fakeProvider(find));

    expect(await resolver.resolve({ authorization: "Basic abc123" })).toBeNull();
    expect(find).not.toHaveBeenCalled();
  });

  it("returns null when the token is not found or invalid", async () => {
    const find = vi.fn().mockResolvedValue(undefined);
    const resolver = new OidcBearerSessionResolver(fakeProvider(find));

    const result = await resolver.resolve({ authorization: "Bearer tok_missing" });

    expect(result).toBeNull();
    expect(find).toHaveBeenCalledWith("tok_missing");
  });

  it("returns null when the resolved token is no longer valid", async () => {
    const find = vi.fn().mockResolvedValue({ accountId: "auth_01", grantId: "grant_01", isValid: false });
    const resolver = new OidcBearerSessionResolver(fakeProvider(find));

    expect(await resolver.resolve({ authorization: "Bearer tok_expired" })).toBeNull();
  });

  it("resolves a valid access token to a customer identity keyed by the grant", async () => {
    const find = vi.fn().mockResolvedValue({ accountId: "auth_01", grantId: "grant_01", isValid: true });
    const resolver = new OidcBearerSessionResolver(fakeProvider(find));

    const result = await resolver.resolve({ authorization: "bearer tok_valid" });

    expect(result).toEqual({
      betterAuthUserId: "auth_01",
      providerSessionId: "grant_01",
      population: "customer",
    });
  });
});
