import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";
import { isAddress } from "viem";

import {
  canonicalWalletAddress,
  toChecksumWalletAddress,
} from "../src/shared/domain/wallet-address.js";

// The EIP-55 reference vectors from the specification.
const eip55Vectors = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
];

describe("canonicalWalletAddress", () => {
  it.each(eip55Vectors)("lowercases the EIP-55 spelling %s", (vector) => {
    expect(canonicalWalletAddress(vector)).toBe(vector.toLowerCase());
  });

  it("lowercases an all-uppercase and a mixed-case hex body", () => {
    expect(canonicalWalletAddress(`0x${"ABCDEF0123".repeat(4)}`)).toBe(`0x${"abcdef0123".repeat(4)}`);
    expect(canonicalWalletAddress("0xAbCdEf0123AbCdEf0123AbCdEf0123AbCdEf0123")).toBe(
      "0xabcdef0123abcdef0123abcdef0123abcdef0123",
    );
  });

  it("trims space, tab and newline from both ends", () => {
    const canonical = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";
    expect(canonicalWalletAddress(`  ${canonical}`)).toBe(canonical);
    expect(canonicalWalletAddress(`${canonical}\t`)).toBe(canonical);
    expect(canonicalWalletAddress(`\n ${canonical.toUpperCase().replace("0X", "0x")} \r\n`)).toBe(canonical);
  });

  it("is idempotent", () => {
    for (const vector of eip55Vectors) {
      const once = canonicalWalletAddress(vector);
      expect(canonicalWalletAddress(once)).toBe(once);
    }
  });

  it("drops the EIP-55 checksum: a mistyped checksummed address becomes one viem accepts", () => {
    // Same address as the first vector with its last hex digit changed, so the
    // casing no longer matches the checksum. viem's strict check refuses it as
    // typed (the only typo guard a typed transfer recipient had before this
    // form) and accepts it once lowercased, because lowercase carries no
    // checksum to fail.
    const mistyped = "0x71C7656EC7ab88b098defB751B7401B5f6d8976E";
    expect(isAddress(mistyped, { strict: true })).toBe(false);
    expect(isAddress(canonicalWalletAddress(mistyped), { strict: true })).toBe(true);
  });

  it("does not validate: an 0X prefix is lowercased, which is why the edge regex runs first", () => {
    expect(canonicalWalletAddress(`0X${"a".repeat(40)}`)).toBe(`0x${"a".repeat(40)}`);
    expect(canonicalWalletAddress("not-an-address")).toBe("not-an-address");
    expect(canonicalWalletAddress("")).toBe("");
  });
});

describe("toChecksumWalletAddress", () => {
  it.each(eip55Vectors)("turns the lowercase form into the EIP-55 spelling %s", (vector) => {
    expect(toChecksumWalletAddress(vector.toLowerCase())).toBe(vector);
  });

  it("checksums an all-uppercase hex body", () => {
    const vector = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    expect(toChecksumWalletAddress(`0x${vector.slice(2).toUpperCase()}`)).toBe(vector);
  });

  it("returns a value that is not an address unchanged", () => {
    const notAddresses = [
      "0xdifferent",
      "0x71c7656ec7ab88b098defb751b7401b5f6d8976", // 39 hex digits
      "0X71c7656ec7ab88b098defb751b7401b5f6d8976f", // 0X prefix
      " 0x71c7656ec7ab88b098defb751b7401b5f6d8976f", // surrounding whitespace
      "",
    ];
    for (const value of notAddresses) {
      expect(toChecksumWalletAddress(value)).toBe(value);
    }
  });

  it("round-trips: canonicalising the checksum spelling gives back the canonical form", () => {
    for (let index = 0; index < 50; index += 1) {
      const canonical = `0x${randomBytes(20).toString("hex")}`;
      const checksummed = toChecksumWalletAddress(canonical);
      expect(checksummed.toLowerCase()).toBe(canonical);
      expect(canonicalWalletAddress(checksummed)).toBe(canonical);
    }
  });
});
