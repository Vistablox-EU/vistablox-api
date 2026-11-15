import { describe, expect, it } from "vitest";

import {
  describeEvidence,
  isValidChainHash,
  normalizeChainHash,
} from "../src/shared/domain/wallet-registration-evidence.js";

const HASH = `0x${"ab".repeat(32)}`;
const OTHER = `0x${"cd".repeat(32)}`;
const AT = new Date("2026-11-13T10:00:00.000Z");

describe("normalizeChainHash and isValidChainHash", () => {
  it("lower-cases and trims", () => {
    expect(normalizeChainHash(`  0x${"AB".repeat(32)} `)).toBe(HASH);
  });

  it("accepts only lower-case 0x plus 64 hex digits", () => {
    expect(isValidChainHash(HASH)).toBe(true);
    expect(isValidChainHash(`0x${"AB".repeat(32)}`)).toBe(false);
    expect(isValidChainHash(`0x${"ab".repeat(31)}`)).toBe(false);
    expect(isValidChainHash(`0x${"ab".repeat(33)}`)).toBe(false);
    expect(isValidChainHash(`${"ab".repeat(32)}`)).toBe(false);
    expect(isValidChainHash(`0x${"zz".repeat(32)}`)).toBe(false);
    expect(isValidChainHash("")).toBe(false);
  });
});

describe("describeEvidence", () => {
  it("is none for a row without any evidence", () => {
    expect(describeEvidence({})).toBe("none");
    expect(describeEvidence({ transactionHash: null, blockNumber: null, blockHash: null, logIndex: null })).toBe("none");
  });

  it("is partial for a transaction hash and block number without block hash and log index", () => {
    expect(describeEvidence({ transactionHash: HASH, blockNumber: 12n, blockHash: null, logIndex: null })).toBe("partial");
  });

  it("is recorded for the full identity that is not verified yet", () => {
    expect(describeEvidence({ transactionHash: HASH, blockNumber: 12n, blockHash: OTHER, logIndex: 0 })).toBe("recorded");
  });

  it("treats log index 0 as present", () => {
    expect(describeEvidence({ transactionHash: HASH, blockNumber: 0n, blockHash: OTHER, logIndex: 0, verifiedAt: AT })).toBe("verified");
  });

  it("is verified once verified_at is set", () => {
    expect(describeEvidence({ transactionHash: HASH, blockNumber: 12n, blockHash: OTHER, logIndex: 3, verifiedAt: AT })).toBe("verified");
  });

  it("is flagged when flagged_at is set, whatever else is set", () => {
    expect(
      describeEvidence({ transactionHash: HASH, blockNumber: 12n, blockHash: OTHER, logIndex: 3, verifiedAt: AT, flaggedAt: AT }),
    ).toBe("flagged");
  });
});
