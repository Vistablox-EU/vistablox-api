import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";
import { isSettlementBundleConfigured } from "../src/infrastructure/blockchain/settlement-bundle.js";

// This predicate decides whether the worker creates the escrow campaign queue
// AND whether opening an offering enqueues into it, so it must agree with what
// environment.ts accepts as a configured bundle.
const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-test-secret-that-is-long-enough",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "no-reply@example.com",
  DIDIT_API_KEY: "key",
  DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
  DIDIT_WEBHOOK_SECRET: "a-didit-webhook-secret-value-32-chars",
  DIDIT_APPLICATION_ID: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  DIDIT_ENVIRONMENT: "sandbox",
};
const baseChain = {
  CHAIN_NETWORK: "base-sepolia",
  CHAIN_RPC_URL: "https://sepolia.base.org",
  CHAIN_OPERATOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
};
const bundle = {
  VISTABLOX_PROPERTY_CONTRACT_ADDRESS: `0x${"a".repeat(40)}`,
  VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS: `0x${"b".repeat(40)}`,
  EURC_TOKEN_ADDRESS: `0x${"c".repeat(40)}`,
  PIV_TREASURY_ADDRESS: `0x${"d".repeat(40)}`,
};

describe("isSettlementBundleConfigured", () => {
  it("is false for the dormant launch configuration (AD-234)", () => {
    expect(isSettlementBundleConfigured(loadEnvironment(base))).toBe(false);
  });

  it("is false for chain connectivity alone, which only the wallet-registry consumer needs", () => {
    expect(isSettlementBundleConfigured(loadEnvironment({ ...base, ...baseChain }))).toBe(false);
  });

  it("is true for connectivity plus the whole bundle", () => {
    expect(isSettlementBundleConfigured(loadEnvironment({ ...base, ...baseChain, ...bundle }))).toBe(true);
  });

  it.each([...Object.keys(baseChain), ...Object.keys(bundle)])("is false when %s is missing", (missing) => {
    const settings: Record<string, string | undefined> = { ...baseChain, ...bundle };
    settings[missing] = undefined;
    expect(isSettlementBundleConfigured(settings)).toBe(false);
  });
});
