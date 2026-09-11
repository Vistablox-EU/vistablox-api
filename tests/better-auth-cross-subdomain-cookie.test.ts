import { describe, expect, it } from "vitest";

import { deriveCrossSubDomainCookieDomain } from "../src/modules/auth/infrastructure/better-auth.factory.js";

describe("deriveCrossSubDomainCookieDomain", () => {
  it("derives the shared parent domain for a three-label host", () => {
    expect(deriveCrossSubDomainCookieDomain("https://api.vistablox.io")).toBe(".vistablox.io");
  });

  it("stays undefined for a single-label host (local dev)", () => {
    expect(deriveCrossSubDomainCookieDomain("http://localhost:3000")).toBeUndefined();
  });

  it("stays undefined for a two-label host with no subdomain to share", () => {
    expect(deriveCrossSubDomainCookieDomain("https://vistablox.io")).toBeUndefined();
  });

  // Regression for what this was extracted to fix: this function takes only
  // BETTER_AUTH_URL, with no rpId parameter at all, so cookie scoping
  // structurally cannot follow a separately-configured rpId if the two
  // ever diverge (the admin-subdomain rpId question raised separately).
  it("derives the same domain for a four-label host too, following the same single-level-of-nesting rule", () => {
    expect(deriveCrossSubDomainCookieDomain("https://staging.api.vistablox.io")).toBe(
      ".api.vistablox.io",
    );
  });
});
