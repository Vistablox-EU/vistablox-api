import { describe, expect, it, vi } from "vitest";

import { BetterAuthSessionRevoker } from "../src/modules/auth/infrastructure/better-auth-session-revoker.js";

describe("BetterAuthSessionRevoker", () => {
  it("resolves a revocation token only from the authenticated caller's session list", async () => {
    const listSessions = vi.fn().mockResolvedValue([
      { id: "provider_session_01", token: "secret_session_token" },
    ]);
    const revokeSession = vi.fn().mockResolvedValue(undefined);
    const revoker = new BetterAuthSessionRevoker({ api: { listSessions, revokeSession } } as never);
    const headers = { cookie: "vb.session_token=current" };

    await revoker.revoke("provider_session_01", headers);

    expect(listSessions).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    expect(revokeSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { token: "secret_session_token" },
    });
  });

  it("does not attempt revocation for a session absent from the caller's live sessions", async () => {
    const listSessions = vi.fn().mockResolvedValue([]);
    const revokeSession = vi.fn();
    const revoker = new BetterAuthSessionRevoker({ api: { listSessions, revokeSession } } as never);

    await revoker.revoke("provider_session_not_owned", {});

    expect(revokeSession).not.toHaveBeenCalled();
  });
});
