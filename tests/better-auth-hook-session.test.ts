import { describe, expect, it } from "vitest";

import { parseSignedBearerToken } from "../src/modules/auth/infrastructure/better-auth-hook-session.js";

// parseSignedBearerToken has to agree with better-auth's own bearer() plugin
// (better-auth/plugins/bearer) about which Authorization headers it turns into
// the session cookie: a hook that resolves a session bearer() would not, or
// misses one it would, checks a different session from the one the endpoint
// then acts on.
describe("parseSignedBearerToken", () => {
  it("returns the signed token of a Bearer header", () => {
    expect(parseSignedBearerToken("Bearer abc.def=")).toBe("abc.def=");
  });

  it("accepts the scheme in any case and trims the token, as bearer() does", () => {
    expect(parseSignedBearerToken("bearer abc.def=")).toBe("abc.def=");
    expect(parseSignedBearerToken("BEARER   abc.def=  ")).toBe("abc.def=");
  });

  it("decodes a percent-encoded token, and keeps one that does not decode", () => {
    expect(parseSignedBearerToken("Bearer abc.def%3D")).toBe("abc.def=");
    expect(parseSignedBearerToken("Bearer abc.%E0%A4%A")).toBe("abc.%E0%A4%A");
  });

  it("ignores a token without a signature part (the factory requires signed tokens)", () => {
    expect(parseSignedBearerToken("Bearer rawsessiontoken")).toBeNull();
  });

  it("ignores other schemes, an empty token and a missing header", () => {
    expect(parseSignedBearerToken("Basic abc.def=")).toBeNull();
    expect(parseSignedBearerToken("DPoP abc.def=")).toBeNull();
    expect(parseSignedBearerToken("Bearer ")).toBeNull();
    expect(parseSignedBearerToken("Bearer")).toBeNull();
    expect(parseSignedBearerToken("")).toBeNull();
    expect(parseSignedBearerToken(null)).toBeNull();
    expect(parseSignedBearerToken(undefined)).toBeNull();
  });
});
