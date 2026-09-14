import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

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

const settlementBundle = {
  VISTABLOX_PROPERTY_CONTRACT_ADDRESS: `0x${"a".repeat(40)}`,
  VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS: `0x${"b".repeat(40)}`,
  EURC_TOKEN_ADDRESS: `0x${"c".repeat(40)}`,
  PIV_TREASURY_ADDRESS: `0x${"d".repeat(40)}`,
};

describe("chain settlement environment", () => {
  it("keeps on-chain settlement fully optional", () => {
    expect(loadEnvironment(base).CHAIN_NETWORK).toBeUndefined();
  });

  it("accepts base chain connectivity alone, without the property/IPO-escrow settlement bundle -- confirmWalletRegistrations' own requirement", () => {
    expect(loadEnvironment({ ...base, ...baseChain })).toMatchObject(baseChain);
  });

  it("accepts the full bundle (base connectivity + property/IPO-escrow settlement)", () => {
    expect(
      loadEnvironment({ ...base, ...baseChain, ...settlementBundle }),
    ).toMatchObject({ ...baseChain, ...settlementBundle });
  });

  it("rejects a partial base-connectivity configuration", () => {
    expect(() =>
      loadEnvironment({ ...base, CHAIN_NETWORK: "base-sepolia", CHAIN_RPC_URL: "https://sepolia.base.org" }),
    ).toThrow("CHAIN_NETWORK, CHAIN_RPC_URL, and CHAIN_OPERATOR_PRIVATE_KEY must be configured together");
  });

  it("rejects a partial settlement bundle", () => {
    expect(() =>
      loadEnvironment({
        ...base,
        ...baseChain,
        VISTABLOX_PROPERTY_CONTRACT_ADDRESS: settlementBundle.VISTABLOX_PROPERTY_CONTRACT_ADDRESS,
      }),
    ).toThrow(
      "VISTABLOX_PROPERTY_CONTRACT_ADDRESS, VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS, EURC_TOKEN_ADDRESS, and PIV_TREASURY_ADDRESS must be configured together",
    );
  });

  it("rejects the settlement bundle without base chain connectivity", () => {
    expect(() => loadEnvironment({ ...base, ...settlementBundle })).toThrow(
      "must be configured together, and only alongside CHAIN_NETWORK/CHAIN_RPC_URL/CHAIN_OPERATOR_PRIVATE_KEY",
    );
  });

  it("keeps the wallet registry address independent of both the base connectivity and the settlement bundle", () => {
    const walletRegistryAddress = `0x${"e".repeat(40)}`;
    expect(
      loadEnvironment({ ...base, VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS: walletRegistryAddress }),
    ).toMatchObject({ VISTABLOX_WALLET_REGISTRY_CONTRACT_ADDRESS: walletRegistryAddress });
  });
});
