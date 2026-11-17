import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";
import { offeringRepositoryOptions } from "../src/modules/offering/repository/offering-repository-options.js";

// The API process builds its PrismaOfferingRepository with these options, and
// the repository's default is "no gate" (#176, AD-286): this is the wiring that
// switches the reservation gate on wherever the settlement bundle is
// configured, and nothing else would notice if it stopped.
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
const escrow = `0x${"b".repeat(40)}`;
const bundle = {
  VISTABLOX_PROPERTY_CONTRACT_ADDRESS: `0x${"a".repeat(40)}`,
  VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS: escrow,
  EURC_TOKEN_ADDRESS: `0x${"c".repeat(40)}`,
  PIV_TREASURY_ADDRESS: `0x${"d".repeat(40)}`,
};

describe("offeringRepositoryOptions", () => {
  it("gates reservations on the configured escrow contract where the settlement bundle is configured", () => {
    const options = offeringRepositoryOptions(loadEnvironment({ ...base, ...baseChain, ...bundle }));

    expect(options.settlementEscrowContractAddress).toBe(escrow);
  });

  it("does not gate them while the bundle is dormant (the AD-234 launch configuration)", () => {
    expect(offeringRepositoryOptions(loadEnvironment(base)).settlementEscrowContractAddress).toBeUndefined();
  });

  it("does not gate them on chain connectivity alone, which only the wallet-registry consumer needs", () => {
    expect(
      offeringRepositoryOptions(loadEnvironment({ ...base, ...baseChain })).settlementEscrowContractAddress,
    ).toBeUndefined();
  });

  it.each([...Object.keys(baseChain), ...Object.keys(bundle)])(
    "does not gate them when %s is missing, as the worker's predicate says the bundle is not configured",
    (missing) => {
      const settings: Record<string, string | undefined> = { ...baseChain, ...bundle };
      settings[missing] = undefined;

      expect(offeringRepositoryOptions(settings).settlementEscrowContractAddress).toBeUndefined();
    },
  );

  it("passes the disclosures bucket through, and leaves it unset when storage is not configured", () => {
    expect(offeringRepositoryOptions({ MINIO_DISCLOSURES_BUCKET: "disclosures" }).disclosuresBucket).toBe("disclosures");
    expect(offeringRepositoryOptions({}).disclosuresBucket).toBeUndefined();
  });
});
