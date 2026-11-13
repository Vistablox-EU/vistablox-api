import { describe, expect, it } from "vitest";

import { withoutComments } from "./support/without-comments.js";

describe("withoutComments", () => {
  it("blanks line, block and trailing comments and keeps every line where it was", () => {
    const source = [
      "// a leading line comment",
      "const a = 1; // trailing",
      "/* block",
      "   over two lines */",
      "if (a) {",
      "  // await removed();",
      "  go(/* inline */ a);",
      "  // last thing before the brace",
      "}",
      "/** doc */ export const b = 2;",
      "// at the very end",
    ].join("\n");

    const stripped = withoutComments(source);

    expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
    expect(stripped.length).toBe(source.length);
    expect(stripped).not.toMatch(/comment|trailing|block|over two|removed|inline|last thing|doc|very end/);
    expect(stripped.replace(/\s+/g, " ").trim()).toBe("const a = 1; if (a) { go( a); } export const b = 2;");
  });

  it("leaves comment markers inside strings, templates and regular expressions alone", () => {
    const source = [
      'const url = "https://example.test/a//b"; // gone',
      "const cron = \"*/5 * * * *\";",
      "const pattern = /\\/\\/ not a comment/u;",
      "const text = `a // b ${url} /* c */`;",
    ].join("\n");

    const stripped = withoutComments(source);

    expect(stripped).toContain('"https://example.test/a//b"');
    expect(stripped).toContain('"*/5 * * * *"');
    expect(stripped).toContain("/\\/\\/ not a comment/u");
    expect(stripped).toContain("`a // b ${url} /* c */`");
    expect(stripped).not.toContain("gone");
  });

  it("returns source without comments unchanged", () => {
    const source = "export const answer = 42;\n";

    expect(withoutComments(source)).toBe(source);
  });
});
