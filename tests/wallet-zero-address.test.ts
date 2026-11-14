import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWalletRouter, type WalletFreshAuthenticationProbe } from "../src/modules/wallet/api/wallet.router.js";
import {
  registerWalletBodySchema,
  requestWalletTransferBodySchema,
} from "../src/modules/wallet/api/wallet.schemas.js";
import { GetWalletStatusService } from "../src/modules/wallet/application/get-wallet-status.service.js";
import { RegisterWalletService } from "../src/modules/wallet/application/register-wallet.service.js";
import {
  RequestWalletTransferService,
  type WalletTransferChainReader,
} from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import type { WalletRepository } from "../src/modules/wallet/repository/wallet.repository.js";
import type { KycEligibilityReader } from "../src/modules/identity/repository/kyc-eligibility-reader.js";
import type { PivTokenHoldingsReader } from "../src/modules/settlement/repository/settlement.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

// The router asks this for every valid customer POST /wallet; these tests are
// not about the freshness of the session.
const freshProbe: WalletFreshAuthenticationProbe = async () => true;

const ZERO_ADDRESS ="0x0000000000000000000000000000000000000000";
const REGISTRY_ADDRESS = "0x1234567890123456789012345678901234567890";
const CHECKSUMMED = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";
const LOWERCASE = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f";

// Addresses that merely look like the zero address must keep working.
const NOT_ZERO_ADDRESSES = [
  ["checksummed", CHECKSUMMED],
  ["lowercase", LOWERCASE],
  ["uppercase hex", "0x71C7656EC7AB88B098DEFB751B7401B5F6D8976F"],
  ["lowercase with surrounding whitespace", `  ${LOWERCASE}\n`],
  ["leading zeros, mixed case (beacon deposit contract)", "0x00000000219ab540356cbb839cbe05303d7705fa"],
  ["one bit set", "0x0000000000000000000000000000000000000001"],
  ["dead address", "0x000000000000000000000000000000000000dEaD"],
] as const;

const NOT_AN_ADDRESS = [
  ["uppercase 0X prefix on the zero address", `0X${"0".repeat(40)}`],
  ["39 zeros", `0x${"0".repeat(39)}`],
  ["41 zeros", `0x${"0".repeat(41)}`],
  ["zero address plus a NUL byte", `${ZERO_ADDRESS}\u0000`],
  ["empty string", ""],
  ["prefix only", "0x"],
] as const;

describe("wallet address schema: the zero address", () => {
  it("is rejected for wallet_address with one custom issue", () => {
    const result = registerWalletBodySchema.safeParse({ wallet_address: ZERO_ADDRESS });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { code: "custom", path: ["wallet_address"], message: "Must not be the zero address" },
    ]);
  });

  it("is rejected for to_wallet_address with one custom issue", () => {
    const result = requestWalletTransferBodySchema.safeParse({
      piv_id: "piv_01",
      to_wallet_address: ZERO_ADDRESS,
      amount: "3",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([
      { code: "custom", path: ["to_wallet_address"], message: "Must not be the zero address" },
    ]);
  });

  it("is rejected after trimming, because the value that would be stored is the trimmed one", () => {
    const result = registerWalletBodySchema.safeParse({ wallet_address: `\t ${ZERO_ADDRESS}\n` });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toMatchObject([{ code: "custom", message: "Must not be the zero address" }]);
  });

  it.each(NOT_AN_ADDRESS)("keeps the shape message, and only it, for %s", (_label, value) => {
    const result = registerWalletBodySchema.safeParse({ wallet_address: value });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({
      code: "invalid_format",
      message: "Must be a 20-byte, 0x-prefixed hex address",
    });
  });

  it.each(NOT_ZERO_ADDRESSES)("still accepts %s on both schemas", (_label, value) => {
    const registered = registerWalletBodySchema.safeParse({ wallet_address: value });
    const transfer = requestWalletTransferBodySchema.safeParse({
      piv_id: "piv_01",
      to_wallet_address: value,
      amount: "3",
    });

    // Compared case-insensitively on purpose: whether the parsed value keeps
    // the caller's hex case is the canonical-form change's call, not this one's.
    expect(registered.data?.wallet_address.toLowerCase()).toBe(value.trim().toLowerCase());
    expect(transfer.data?.to_wallet_address.toLowerCase()).toBe(value.trim().toLowerCase());
  });
});

// Every collaborator the services could reach past validation is replaced by
// an object whose methods throw and are recorded. A request that gets past the
// edge therefore both fails loudly (500) and leaves a trace in `calls`, and a
// method added to a port later is covered without touching this test.
function untouchable<T extends object>(name: string, calls: string[]): T {
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property === "symbol" || property === "then") {
        return undefined;
      }
      return () => {
        calls.push(`${name}.${property}`);
        throw new Error(`${name}.${property} was called before the address was validated`);
      };
    },
  }) as T;
}

const authenticated: RequestHandler = (_request, response, next) => {
  response.locals.authContext = {
    accountId: "acct_01",
    providerSessionId: "session_01",
    population: "customer",
  };
  next();
};

function mount(router: express.Router) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use("/v1/investor-profile/wallet", router);
  app.use(errorHandler);
  return app;
}

function buildGuardedApp(options: { registryConfigured: boolean } = { registryConfigured: true }) {
  const calls: string[] = [];
  const repository = untouchable<WalletRepository>("walletRepository", calls);
  const app = mount(
    createWalletRouter(
      authenticated,
      freshProbe,
      new RegisterWalletService(
        repository,
        untouchable<KycEligibilityReader>("kycEligibilityReader", calls),
        options.registryConfigured ? REGISTRY_ADDRESS : undefined,
      ),
      new GetWalletStatusService(repository),
      undefined,
      new RequestWalletTransferService(
        repository,
        untouchable<PivTokenHoldingsReader>("pivTokenHoldingsReader", calls),
        untouchable<WalletTransferChainReader>("chainReader", calls),
      ),
    ),
  );
  return { app, calls };
}

describe("POST /v1/investor-profile/wallet with the zero address", () => {
  it("is a 422 validation error that names wallet_address and reaches no KYC, repository or chain call", async () => {
    const { app, calls } = buildGuardedApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: ZERO_ADDRESS });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      type: "https://api.vistablox.io/errors/validation.invalid_field",
      code: "validation.invalid_field",
      title: "Request validation failed",
      status: 422,
      detail: "One or more fields did not pass validation.",
      field_errors: [
        { field: "wallet_address", code: "custom", message: "Must not be the zero address" },
      ],
    });
    expect(response.body.trace_id).toEqual(expect.any(String));
    expect(calls).toEqual([]);
  });

  it("is rejected when padded with whitespace", async () => {
    const { app, calls } = buildGuardedApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: ` ${ZERO_ADDRESS} ` });

    expect(response.status).toBe(422);
    expect(response.body.field_errors).toEqual([
      { field: "wallet_address", code: "custom", message: "Must not be the zero address" },
    ]);
    expect(calls).toEqual([]);
  });

  it("is rejected before the registry-not-configured 503, like any other invalid address", async () => {
    const { app, calls } = buildGuardedApp({ registryConfigured: false });

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: ZERO_ADDRESS });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("validation.invalid_field");
    expect(calls).toEqual([]);
  });

  it("is rejected every time it is replayed, sequentially and in parallel, and nothing is ever stored", async () => {
    const { app, calls } = buildGuardedApp();
    const send = () =>
      request(app).post("/v1/investor-profile/wallet").send({ wallet_address: ZERO_ADDRESS });

    const sequential = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      sequential.push(await send());
    }
    const parallel = await Promise.all(Array.from({ length: 20 }, send));

    expect([...sequential, ...parallel].map((response) => response.status)).toEqual(
      Array.from({ length: 25 }, () => 422),
    );
    expect(calls).toEqual([]);
  });
});

describe("POST /v1/investor-profile/wallet/transfers with the zero address", () => {
  it("is a 422 validation error that names to_wallet_address and reaches no repository or chain call", async () => {
    const { app, calls } = buildGuardedApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: ZERO_ADDRESS, amount: "3" });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: "validation.invalid_field",
      status: 422,
      field_errors: [
        { field: "to_wallet_address", code: "custom", message: "Must not be the zero address" },
      ],
    });
    expect(calls).toEqual([]);
  });

  it("reports the zero address next to an unrelated bad field instead of hiding either", async () => {
    const { app, calls } = buildGuardedApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: ZERO_ADDRESS, amount: "0" });

    expect(response.status).toBe(422);
    expect(response.body.field_errors.map((error: { field: string }) => error.field).sort()).toEqual([
      "amount",
      "to_wallet_address",
    ]);
    expect(calls).toEqual([]);
  });

  it("is rejected every time it is replayed, sequentially and in parallel", async () => {
    const { app, calls } = buildGuardedApp();
    const send = () =>
      request(app)
        .post("/v1/investor-profile/wallet/transfers")
        .send({ piv_id: "piv_01", to_wallet_address: ZERO_ADDRESS, amount: "3" });

    const responses = [await send(), await send(), ...(await Promise.all(Array.from({ length: 20 }, send)))];

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 22 }, () => 422),
    );
    expect(calls).toEqual([]);
  });
});

// The services are stubbed here so the test pins only what the router hands
// them, whatever the repository or chain layers do with it later.
function buildStubbedApp() {
  const registerExecute = vi.fn().mockResolvedValue({
    data: {
      wallet_address: LOWERCASE,
      registration_commitment: `0x${"ab".repeat(32)}`,
      registry_contract_address: REGISTRY_ADDRESS,
      status: "pending",
      requested_at: "2026-09-02T10:00:00.000Z",
      registered_at: null,
    },
  });
  const transferExecute = vi.fn().mockResolvedValue({
    data: {
      piv_id: "piv_01",
      token_id: "7",
      amount: "3",
      from_wallet_address: LOWERCASE,
      to_wallet_address: LOWERCASE,
      unsigned_transaction: { chain_id: 84532, to: "0xproperty", data: "0xdeadbeef", value: "0" },
    },
  });
  const app = mount(
    createWalletRouter(
      authenticated,
      freshProbe,
      { execute: registerExecute } as unknown as RegisterWalletService,
      { execute: vi.fn() } as unknown as GetWalletStatusService,
      undefined,
      { execute: transferExecute } as unknown as RequestWalletTransferService,
    ),
  );
  return { app, registerExecute, transferExecute };
}

describe("valid addresses still pass the edge", () => {
  it.each([
    ["checksummed", CHECKSUMMED],
    ["lowercase", LOWERCASE],
  ])("registers a %s address", async (_label, address) => {
    const { app, registerExecute } = buildStubbedApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet")
      .send({ wallet_address: address });

    expect(response.status).toBe(201);
    expect(registerExecute).toHaveBeenCalledTimes(1);
    const handed = registerExecute.mock.calls[0]?.[0] as { accountId: string; walletAddress: string };
    expect(handed.accountId).toBe("acct_01");
    expect(handed.walletAddress.toLowerCase()).toBe(address.toLowerCase());
  });

  it.each([
    ["checksummed", CHECKSUMMED],
    ["lowercase", LOWERCASE],
  ])("accepts a %s transfer destination", async (_label, address) => {
    const { app, transferExecute } = buildStubbedApp();

    const response = await request(app)
      .post("/v1/investor-profile/wallet/transfers")
      .send({ piv_id: "piv_01", to_wallet_address: address, amount: "3" });

    expect(response.status).toBe(200);
    expect(transferExecute).toHaveBeenCalledTimes(1);
    const handed = transferExecute.mock.calls[0]?.[0] as { toWalletAddress: string };
    expect(handed.toWalletAddress.toLowerCase()).toBe(address.toLowerCase());
  });
});
