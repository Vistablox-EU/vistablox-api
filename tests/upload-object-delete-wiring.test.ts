import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// A service built without a logger swallows a failed object delete silently,
// exactly as before, so the logger has to reach both upload services where
// they are built. src/server.ts is a start-up script that cannot be imported
// into a test and the offering service is built inside createApp, which needs
// the whole protected API, so the source is read instead, the way
// tests/coinbase-onramp-webhook-wiring.test.ts does.
//
// It looks at every `new <Service>(...)` under src/ rather than at one file,
// so moving the construction (the per-module composition split, for one) does
// not break it; only losing the logger argument does. The TypeScript parser
// finds the calls, so formatting and comments do not matter.
const srcDirectory = fileURLToPath(new URL("../src/", import.meta.url));

function constructions(className: string): Array<{ file: string; args: string[] }> {
  const found: Array<{ file: string; args: string[] }> = [];
  const files = readdirSync(srcDirectory, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts") && !path.startsWith("generated"));
  for (const file of files) {
    const text = readFileSync(`${srcDirectory}${file}`, "utf8");
    if (!text.includes(`new ${className}(`)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === className) {
        found.push({ file, args: (node.arguments ?? []).map((argument) => argument.getText(source)) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

describe("object-delete logging wiring", () => {
  it("builds UploadCaseDocumentService with a logger as its fifth argument", () => {
    const built = constructions("UploadCaseDocumentService");
    expect(built.length).toBeGreaterThan(0);
    for (const { file, args } of built) {
      expect(args, file).toHaveLength(5);
      expect(args[4], file).toMatch(/\blogger\b/);
    }
  });

  it("builds UploadOfferingDocumentService with a logger as its fifth argument", () => {
    const built = constructions("UploadOfferingDocumentService");
    expect(built.length).toBeGreaterThan(0);
    for (const { file, args } of built) {
      expect(args, file).toHaveLength(5);
      expect(args[4], file).toMatch(/\blogger\b/);
    }
  });
});
