import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// docs/investor-profile.md documents the wallet endpoints under one "##" section. The fresh-
// authentication change added a "###" subsection inside it, and nothing returned to the wallet
// topic afterwards, so every later paragraph (double submits, escrow-mint attribution, the on-chain
// half, the staff reconcile route, the status and balance reads) ended up structurally inside
// "Replacing a pending claim". Anchors and the heading outline were wrong although the text was
// right. These tests pin the outline, not the prose.

const DOC = readFileSync(fileURLToPath(new URL("../docs/investor-profile.md", import.meta.url)), "utf8");

const WALLET_SECTION = "Wallet registration";
const REPLACE_SECTION = "Replacing a pending claim: fresh authentication";

interface Section {
  level: number;
  title: string;
  /** Titles of the enclosing headings, outermost first. */
  ancestors: string[];
  /** Text from this heading to the next heading of any level, so a subsection is not counted twice. */
  paragraphs: string[];
}

/** Splits the document at ATX headings, ignoring "#" lines inside fenced code blocks. */
function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let inFence = false;
  let current: Section | undefined;
  let paragraph: string[] = [];

  const closeParagraph = () => {
    if (current !== undefined && paragraph.length > 0) current.paragraphs.push(paragraph.join("\n"));
    paragraph = [];
  };

  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      closeParagraph();
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      current = { level, title: heading[2]!, ancestors: stack.map((entry) => entry.title), paragraphs: [] };
      sections.push(current);
      stack.push({ level, title: heading[2]! });
    } else if (line.trim() === "") {
      closeParagraph();
    } else {
      paragraph.push(line);
    }
  }
  closeParagraph();
  return sections;
}

const sections = sectionsOf(DOC);

function sectionTitled(title: string): Section {
  const found = sections.find((section) => section.title === title);
  if (found === undefined) throw new Error(`docs/investor-profile.md has no heading "${title}"`);
  return found;
}

/** The section whose own text holds a paragraph starting with the given opener. */
function sectionHoldingParagraph(opener: string): Section {
  const found = sections.filter((section) => section.paragraphs.some((paragraph) => paragraph.startsWith(opener)));
  if (found.length !== 1) {
    throw new Error(`expected exactly one paragraph starting with ${JSON.stringify(opener)}, found ${found.length}`);
  }
  return found[0]!;
}

// One opener per paragraph that followed the replacement subsection in the document.
const WALLET_PARAGRAPHS: Array<[topic: string, opener: string]> = [
  ["double submits", "A double submit of the **same address**"],
  ["escrow-mint attribution", "Escrow-mint attribution (`resolveAccountIdForWallet`)"],
  ["503 when the registry is not configured", "If `VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS`"],
  ["the on-chain half of AD-241", "AD-241's on-chain half"],
  ["the staff reconcile route", "Staff can confirm a registration the watcher missed"],
  ["the wallet status read", "`GET /v1/investor-profile/wallet` reads"],
  ["the balance read", "`GET /v1/investor-profile/wallet/balance`"],
];

describe("docs/investor-profile.md heading outline", () => {
  it("keeps the replacement section a direct subsection of the wallet section", () => {
    const replace = sectionTitled(REPLACE_SECTION);
    expect(replace.level).toBe(3);
    expect(replace.ancestors).toEqual(["Investor profile", WALLET_SECTION]);
  });

  it.each(WALLET_PARAGRAPHS)("does not nest the paragraph on %s inside the replacement section", (_topic, opener) => {
    const holder = sectionHoldingParagraph(opener);
    expect(holder.title).not.toBe(REPLACE_SECTION);
    expect(holder.ancestors).not.toContain(REPLACE_SECTION);
  });

  it.each(WALLET_PARAGRAPHS)("keeps the paragraph on %s under the wallet section", (_topic, opener) => {
    const holder = sectionHoldingParagraph(opener);
    expect([holder.title, ...holder.ancestors]).toContain(WALLET_SECTION);
  });

  it("ends the replacement section after what the client must do and what stays open", () => {
    const replace = sectionTitled(REPLACE_SECTION);
    const text = replace.paragraphs.join("\n\n");
    expect(text).toContain("**What the client must do**");
    expect(text).toContain("**Not covered here, still open:**");
    // Nothing from the rest of the wallet documentation belongs to it.
    for (const foreign of ["/wallet/balance", "reconcile", "resolveAccountIdForWallet", "VistaBloxWalletRegistry"]) {
      expect(text, `replacement section mentions ${foreign}`).not.toContain(foreign);
    }
  });
});
