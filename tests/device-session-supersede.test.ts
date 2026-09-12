import { describe, expect, it } from "vitest";

import { sessionsToSupersede } from "../src/modules/auth/domain/device-session-supersede.js";

const NOW = new Date("2026-09-12T10:00:00.000Z");

function session(id: string, createdAtMs: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    token: `token_${id}`,
    dpopJkt: "jkt",
    authenticationLevel: "device_biometric",
    createdAt: new Date(createdAtMs),
    expiresAt: new Date(NOW.getTime() + 60_000),
    ...overrides,
  };
}

const ids = (sessions: Array<{ id: string }>) => sessions.map((s) => s.id).sort();

describe("sessionsToSupersede: only the newest session on the device's key survives", () => {
  it("revokes every live device session on the key except the newest", () => {
    const sessions = [session("a", 1_000), session("c", 3_000), session("b", 2_000)];

    expect(ids(sessionsToSupersede(sessions, "jkt", NOW))).toEqual(["a", "b"]);
  });

  it("breaks a createdAt tie on id, the same way whatever order the sessions come in", () => {
    const tiedA = session("sess_a", 5_000);
    const tiedB = session("sess_b", 5_000);

    expect(ids(sessionsToSupersede([tiedA, tiedB], "jkt", NOW))).toEqual(["sess_a"]);
    expect(ids(sessionsToSupersede([tiedB, tiedA], "jkt", NOW))).toEqual(["sess_a"]);
  });

  it("ignores other keys, other authentication levels and expired sessions", () => {
    const sessions = [
      session("newest", 9_000),
      session("other_key", 1_000, { dpopJkt: "other-jkt" }),
      session("web", 1_000, { dpopJkt: undefined, authenticationLevel: "unassured" }),
      session("expired", 1_000, { expiresAt: new Date(NOW.getTime() - 1) }),
      session("older", 2_000),
    ];

    expect(ids(sessionsToSupersede(sessions, "jkt", NOW))).toEqual(["older"]);
  });

  it("revokes nothing when the key has only one live device session", () => {
    expect(sessionsToSupersede([session("only", 1_000)], "jkt", NOW)).toEqual([]);
  });

  // Two overlapping ceremonies A (older session) and B (newer) each see some
  // subset of the sessions. Whatever they see, the union of what they revoke
  // leaves exactly the newest.
  it.each([
    ["A sees only itself, B sees both", ["old", "A"], ["old", "A", "B"]],
    ["A sees both (B committed first), B doesn't see A yet", ["old", "A", "B"], ["old", "B"]],
    ["both see both", ["old", "A", "B"], ["old", "A", "B"]],
  ])("overlapping ceremonies leave exactly the newest: %s", (_label, viewA, viewB) => {
    const all = { old: session("old", 1_000), A: session("A", 2_000), B: session("B", 3_000) };
    const pick = (names: string[]) => names.map((name) => all[name as keyof typeof all]);
    const revoked = new Set([
      ...sessionsToSupersede(pick(viewA), "jkt", NOW).map((s) => s.id),
      ...sessionsToSupersede(pick(viewB), "jkt", NOW).map((s) => s.id),
    ]);

    expect(Object.values(all).filter((s) => !revoked.has(s.id)).map((s) => s.id)).toEqual(["B"]);
  });
});
