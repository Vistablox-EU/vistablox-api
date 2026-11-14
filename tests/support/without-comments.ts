import ts from "typescript";

/**
 * The same source with every comment blanked out (each character replaced by a
 * space, newlines kept, so offsets and line numbers do not move).
 *
 * For tests that read a start-up script such as src/worker.ts as text to check
 * what it wires up: a plain `toContain` is satisfied by a call that has been
 * commented out, which is exactly the mistake such a test exists to catch. The
 * TypeScript parser decides what is a comment, so `//` inside a string, a
 * template literal or a regular expression is left alone.
 */
export function withoutComments(source: string): string {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ranges = new Map<number, number>();
  const collect = (position: number): void => {
    const found = [
      ...(ts.getLeadingCommentRanges(source, position) ?? []),
      ...(ts.getTrailingCommentRanges(source, position) ?? []),
    ];
    for (const range of found) ranges.set(range.pos, range.end);
  };
  // Every comment is trivia of some token: leading when it starts a line or
  // follows another comment, trailing when it ends one. getChildren() reaches
  // the punctuation and the end-of-file token that forEachChild skips.
  const visit = (node: ts.Node): void => {
    collect(node.getFullStart());
    collect(node.getEnd());
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);

  let result = source;
  for (const [start, end] of ranges) {
    result = result.slice(0, start) + result.slice(start, end).replace(/[^\n]/g, " ") + result.slice(end);
  }
  return result;
}
