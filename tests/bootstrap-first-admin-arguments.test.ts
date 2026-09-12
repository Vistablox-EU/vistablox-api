import { describe, expect, it } from "vitest";

import { parseBootstrapFirstAdminArguments } from "../src/cli/bootstrap-first-admin-arguments.js";

describe("bootstrap-first-admin CLI arguments", () => {
  it("parses --email and --display-name, normalizing the email and trimming the name", () => {
    expect(
      parseBootstrapFirstAdminArguments([
        "--email",
        " First.Admin@Example.Test ",
        "--display-name",
        "  First Admin ",
      ]),
    ).toEqual({
      ok: true,
      value: { mode: "issue", email: "first.admin@example.test", displayName: "First Admin" },
    });
  });

  it("accepts --option=value form", () => {
    expect(
      parseBootstrapFirstAdminArguments(["--email=a@example.test", "--display-name=A"]),
    ).toEqual({ ok: true, value: { mode: "issue", email: "a@example.test", displayName: "A" } });
  });

  it("parses --check as the read-only mode", () => {
    expect(parseBootstrapFirstAdminArguments(["--check"])).toEqual({
      ok: true,
      value: { mode: "check" },
    });
  });

  it("refuses --check combined with issue options, so a typo can't turn a check into a write", () => {
    expect(
      parseBootstrapFirstAdminArguments(["--check", "--email", "a@example.test"]),
    ).toMatchObject({ ok: false });
  });

  it.each([
    [[], "--email is required"],
    [["--email", "a@example.test"], "--display-name is required"],
    [["--display-name", "A"], "--email is required"],
  ])("requires both identity options (%j)", (argv, error) => {
    expect(parseBootstrapFirstAdminArguments(argv)).toEqual({ ok: false, error });
  });

  it("rejects an invalid email and a blank or overlong display name", () => {
    expect(
      parseBootstrapFirstAdminArguments(["--email", "not-an-email", "--display-name", "A"]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^--email:/) });
    expect(
      parseBootstrapFirstAdminArguments(["--email", "a@example.test", "--display-name", "   "]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^--display-name:/) });
    expect(
      parseBootstrapFirstAdminArguments([
        "--email",
        "a@example.test",
        "--display-name",
        "x".repeat(201),
      ]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/^--display-name:/) });
  });

  it("rejects unknown options and positionals", () => {
    expect(parseBootstrapFirstAdminArguments(["--role", "legal_partner"])).toMatchObject({
      ok: false,
    });
    expect(parseBootstrapFirstAdminArguments(["a@example.test"])).toMatchObject({ ok: false });
  });

  it("supports --help", () => {
    expect(parseBootstrapFirstAdminArguments(["--help"])).toEqual({
      ok: true,
      value: { mode: "help" },
    });
  });
});
