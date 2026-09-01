import { describe, expect, it, vi } from "vitest";

import { CompositeSessionResolver } from "../src/modules/auth/application/composite-session.resolver.js";
import type { SessionResolver } from "../src/modules/auth/application/session-resolver.js";

describe("CompositeSessionResolver", () => {
  it("returns the first resolver's identity without consulting the rest", async () => {
    const first: SessionResolver = {
      resolve: vi.fn().mockResolvedValue({
        betterAuthUserId: "auth_01",
        providerSessionId: "grant_01",
        population: "customer",
      }),
    };
    const second: SessionResolver = { resolve: vi.fn() };

    const result = await new CompositeSessionResolver([first, second]).resolve({});

    expect(result?.betterAuthUserId).toBe("auth_01");
    expect(second.resolve).not.toHaveBeenCalled();
  });

  it("falls through to the next resolver when the first returns null", async () => {
    const first: SessionResolver = { resolve: vi.fn().mockResolvedValue(null) };
    const second: SessionResolver = {
      resolve: vi.fn().mockResolvedValue({
        betterAuthUserId: "auth_02",
        providerSessionId: "auth_session_02",
        population: "customer",
      }),
    };

    const result = await new CompositeSessionResolver([first, second]).resolve({});

    expect(result?.betterAuthUserId).toBe("auth_02");
  });

  it("returns null when every resolver returns null", async () => {
    const resolvers: SessionResolver[] = [
      { resolve: vi.fn().mockResolvedValue(null) },
      { resolve: vi.fn().mockResolvedValue(null) },
    ];

    expect(await new CompositeSessionResolver(resolvers).resolve({})).toBeNull();
  });
});
