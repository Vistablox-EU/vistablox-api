import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createWalletOperationsRouter } from "../src/modules/wallet/api/wallet-operations.router.js";
import { GetWalletAccountForOperationsService } from "../src/modules/wallet/application/get-wallet-account-for-operations.service.js";
import {
  ReconcileWalletRegistrationService,
  WalletRegistrationVerificationError,
  type WalletRegistrationChainVerifier,
} from "../src/modules/wallet/application/reconcile-wallet-registration.service.js";
import {
  WalletAddressConflictError,
  WalletRegistrationChangedError,
  type ReconcileWalletRegistrationResult,
  type RegisteredWallet,
  type WalletRepository,
} from "../src/modules/wallet/repository/wallet.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

// This router implements no auth/authorization logic itself -- it only
// composes whatever guard middleware it's given, exactly like every other
// operations router (see intake-operations.router.ts). Guard behavior
// itself is covered by require-staff-role.test.ts; these stand in as
// pass-through/deny stubs so this file can focus on the service wiring and
// response shape.
const allow: RequestHandler = (_request, _response, next) => next();
function deny(status: number, code: string): RequestHandler {
  return (_request, response) => {
    response.status(status).json({ code });
  };
}

function buildApp(options?: {
  repository?: WalletRepository;
  requireAdminOperations?: RequestHandler;
  requireStaffWebAuthn?: RequestHandler;
}) {
  const repository: WalletRepository =
    options?.repository ??
    ({
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockImplementation((accountId: string) =>
        Promise.resolve(
          accountId === "acct_01"
            ? {
                walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
                registrationCommitment: "0xabc123",
                requestedAt: new Date("2026-09-02T10:00:00.000Z"),
                registeredAt: new Date("2026-09-02T10:05:00.000Z"),
              }
            : null,
        ),
      ),
    } satisfies WalletRepository);

  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/internal/v1/wallet-accounts",
    createWalletOperationsRouter(
      allow,
      options?.requireAdminOperations ?? allow,
      options?.requireStaffWebAuthn ?? allow,
      new GetWalletAccountForOperationsService(repository),
    ),
  );
  app.use(errorHandler);
  return { app, repository };
}

describe("GET /internal/v1/wallet-accounts/:account_id", () => {
  it("returns the wallet registration for a known account", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        account_id: "acct_01",
        wallet_address: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registration_commitment: "0xabc123",
        status: "registered",
        requested_at: "2026-09-02T10:00:00.000Z",
        registered_at: "2026-09-02T10:05:00.000Z",
        registration_evidence: {
          status: "none",
          transaction_hash: null,
          block_number: null,
          block_hash: null,
          log_index: null,
          verified_at: null,
          flag: null,
          flagged_at: null,
        },
      },
    });
  });

  it("reports pending status when the wallet hasn't confirmed on-chain yet", async () => {
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockResolvedValue({
        walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
        registrationCommitment: "0xabc123",
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
        registeredAt: null,
      }),
    };
    const { app } = buildApp({ repository });

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("pending");
    expect(response.body.data.registered_at).toBeNull();
  });

  it("404s for an account with no registered wallet -- not a synthesized empty response", async () => {
    const { app } = buildApp();

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_missing");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("wallet.account_not_found");
  });

  it("denies the request when the admin-operations guard rejects it", async () => {
    const { app, repository } = buildApp({
      requireAdminOperations: deny(403, "authorization.forbidden"),
    });

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(403);
    expect(repository.findByAccountId).not.toHaveBeenCalled();
  });

  it("denies the request when the staff-WebAuthn guard rejects it", async () => {
    const { app, repository } = buildApp({
      requireStaffWebAuthn: deny(403, "authentication.webauthn_required"),
    });

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.status).toBe(403);
    expect(repository.findByAccountId).not.toHaveBeenCalled();
  });
});

describe("GET /internal/v1/wallet-accounts/:account_id registration evidence", () => {
  const TX = `0x${"11".repeat(32)}`;
  const BLOCK = `0x${"22".repeat(32)}`;
  const base: RegisteredWallet = {
    walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
    registrationCommitment: "0xabc123",
    requestedAt: new Date("2026-09-02T10:00:00.000Z"),
    registeredAt: new Date("2026-09-02T10:05:00.000Z"),
  };

  async function evidenceFor(wallet: RegisteredWallet) {
    const repository: WalletRepository = { registerWallet: vi.fn(), findByAccountId: vi.fn().mockResolvedValue(wallet) };
    const { app } = buildApp({ repository });
    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");
    expect(response.status).toBe(200);
    return response.body.data.registration_evidence;
  }

  it("shows a pending registration as having no evidence", async () => {
    expect((await evidenceFor({ ...base, registeredAt: null })).status).toBe("none");
  });

  it("shows a transaction hash and block number without the rest as partial", async () => {
    expect(await evidenceFor({ ...base, registrationTxHash: TX, registrationBlockNumber: 123n })).toEqual({
      status: "partial",
      transaction_hash: TX,
      block_number: "123",
      block_hash: null,
      log_index: null,
      verified_at: null,
      flag: null,
      flagged_at: null,
    });
  });

  it("shows the full identity as recorded, with the block number as a string", async () => {
    expect(
      await evidenceFor({
        ...base,
        registrationTxHash: TX,
        registrationBlockNumber: 9_007_199_254_740_993n,
        registrationBlockHash: BLOCK,
        registrationLogIndex: 0,
      }),
    ).toEqual({
      status: "recorded",
      transaction_hash: TX,
      block_number: "9007199254740993",
      block_hash: BLOCK,
      log_index: 0,
      verified_at: null,
      flag: null,
      flagged_at: null,
    });
  });

  it("shows a verified confirmation with the time it was verified", async () => {
    const evidence = await evidenceFor({
      ...base,
      registrationTxHash: TX,
      registrationBlockNumber: 5n,
      registrationBlockHash: BLOCK,
      registrationLogIndex: 4,
      registrationEvidenceVerifiedAt: new Date("2026-09-02T11:00:00.000Z"),
    });
    expect(evidence).toMatchObject({ status: "verified", verified_at: "2026-09-02T11:00:00.000Z" });
  });

  it("shows a flagged confirmation with the reason and time, while the registration itself stays registered", async () => {
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn().mockResolvedValue({
        ...base,
        registrationTxHash: TX,
        registrationBlockNumber: 5n,
        registrationBlockHash: BLOCK,
        registrationLogIndex: 4,
        registrationEvidenceFlaggedAt: new Date("2026-09-02T12:00:00.000Z"),
        registrationEvidenceFlag: "transaction_missing",
      } satisfies RegisteredWallet),
    };
    const { app } = buildApp({ repository });

    const response = await request(app).get("/internal/v1/wallet-accounts/acct_01");

    expect(response.body.data.status).toBe("registered");
    expect(response.body.data.registration_evidence).toMatchObject({
      status: "flagged",
      flag: "transaction_missing",
      flagged_at: "2026-09-02T12:00:00.000Z",
    });
  });
});

describe("POST /internal/v1/wallet-accounts/:account_id/reconcile", () => {
  const TX = `0x${"bb".repeat(32)}`;
  const BLOCK = `0x${"aa".repeat(32)}`;
  const pending: RegisteredWallet = {
    walletAddress: "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
    registrationCommitment: "0xabc123",
    requestedAt: new Date("2026-09-02T10:00:00.000Z"),
    registeredAt: null,
  };
  const confirmed: RegisteredWallet = {
    ...pending,
    registeredAt: new Date("2026-09-02T10:05:00.000Z"),
    registrationTxHash: TX,
    registrationBlockNumber: 12n,
    registrationBlockHash: BLOCK,
    registrationLogIndex: 2,
  };

  function buildReconcileApp(options: {
    verify?: WalletRegistrationChainVerifier["verify"];
    result?: ReconcileWalletRegistrationResult;
    // What the repository throws instead of answering (the claim-lifecycle outcomes).
    reconcileError?: Error;
    requireAdminOperations?: RequestHandler;
  }) {
    const reconcileWalletRegistration = vi.fn(async (): Promise<ReconcileWalletRegistrationResult> => {
      if (options.reconcileError !== undefined) throw options.reconcileError;
      return options.result ?? { kind: "reconciled", outcome: "confirmed", wallet: confirmed };
    });
    const repository: WalletRepository = {
      registerWallet: vi.fn(),
      findByAccountId: vi.fn(async (accountId: string) => (accountId === "acct_01" ? pending : null)),
      reconcileWalletRegistration,
    };
    const verify = vi.fn(
      options.verify ??
        (async () => ({ transactionHash: TX, blockHash: BLOCK, blockNumber: 12n, logIndex: 2, registeredAt: new Date("2026-09-02T10:05:00.000Z") })),
    );
    const app = express();
    app.use(requestContext);
    app.use(express.json());
    app.use((_request, response, next) => {
      response.locals.authContext = { accountId: "staff_01", providerSessionId: "session_01", population: "staff_partner" };
      next();
    });
    app.use(
      "/internal/v1/wallet-accounts",
      createWalletOperationsRouter(
        allow,
        options.requireAdminOperations ?? allow,
        allow,
        new GetWalletAccountForOperationsService(repository),
        new ReconcileWalletRegistrationService(repository, { verify }),
      ),
    );
    app.use(errorHandler);
    return { app, repository, verify, reconcileWalletRegistration };
  }

  const post = (app: express.Express, accountId = "acct_01", body: unknown = { transaction_hash: TX }) =>
    request(app).post(`/internal/v1/wallet-accounts/${accountId}/reconcile`).send(body as object);

  it("reconciles and returns the evidence and the outcome", async () => {
    const { app, verify } = buildReconcileApp({});

    const response = await post(app, "acct_01", { transaction_hash: TX.toUpperCase().replace("0X", "0x") });

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      account_id: "acct_01",
      status: "registered",
      registration_tx_hash: TX,
      registration_block_number: "12",
      registration_block_hash: BLOCK,
      registration_log_index: 2,
      outcome: "confirmed",
    });
    // The hash was lower-cased at the edge, before the service saw it.
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ txHash: TX }));
  });

  it.each([
    ["transaction_not_found", 422, "wallet.registration_transaction_not_found"],
    ["transaction_reverted", 422, "wallet.registration_transaction_reverted"],
    ["event_not_found", 422, "wallet.registration_event_not_found"],
    ["not_sufficiently_confirmed", 409, "wallet.registration_transaction_unconfirmed"],
    ["chain_unavailable", 503, "wallet.chain_unavailable"],
  ] as const)("answers a %s failure with the documented error envelope (%i %s)", async (reason, status, code) => {
    const { app } = buildReconcileApp({
      verify: async () => {
        throw new WalletRegistrationVerificationError(reason);
      },
    });

    const response = await post(app);

    expect(response.status).toBe(status);
    expect(response.body).toEqual({
      type: `https://api.vistablox.io/errors/${code}`,
      code,
      title: expect.any(String),
      status,
      detail: expect.any(String),
      trace_id: expect.any(String),
    });
  });

  it.each([
    ["different_event", "wallet.registration_evidence_conflict"],
    ["event_taken", "wallet.registration_event_already_used"],
  ] as const)("answers a %s conflict with 409 %s", async (reason, code) => {
    const { app } = buildReconcileApp({ result: { kind: "conflict", reason } });

    const response = await post(app);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(code);
  });

  it("answers 404 for an unknown account without reading the chain", async () => {
    const { app, verify } = buildReconcileApp({});

    const response = await post(app, "acct_missing");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("wallet.account_not_found");
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers 422 for a malformed hash", async () => {
    const { app, verify } = buildReconcileApp({});

    const response = await post(app, "acct_01", { transaction_hash: "0x1234" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("validation.invalid_field");
    expect(verify).not.toHaveBeenCalled();
  });

  it("stops at the guard before touching the repository or the chain", async () => {
    const { app, repository, verify } = buildReconcileApp({ requireAdminOperations: deny(403, "authorization.forbidden") });

    const response = await post(app);

    expect(response.status).toBe(403);
    expect(repository.findByAccountId).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers 409 wallet.registration_changed in the error envelope when the account replaced its claim after the check", async () => {
    const { app } = buildReconcileApp({ reconcileError: new WalletRegistrationChangedError() });

    const response = await post(app);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      type: expect.any(String),
      code: "wallet.registration_changed",
      title: "Wallet registration changed",
      status: 409,
      detail: expect.stringContaining("changed"),
      trace_id: expect.any(String),
    });
  });

  it("answers 409 wallet.address_already_claimed in the error envelope when another account holds the address", async () => {
    const { app } = buildReconcileApp({ reconcileError: new WalletAddressConflictError("address_claimed") });

    const response = await post(app);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      type: expect.any(String),
      code: "wallet.address_already_claimed",
      title: expect.any(String),
      status: 409,
      detail: expect.any(String),
      trace_id: expect.any(String),
    });
  });

  it("hands the verified address and commitment to the repository on success", async () => {
    const { app, reconcileWalletRegistration } = buildReconcileApp({});

    const response = await post(app);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ account_id: "acct_01", status: "registered" });
    expect(reconcileWalletRegistration).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct_01",
        actorAccountId: "staff_01",
        expectedWalletAddress: pending.walletAddress,
        expectedRegistrationCommitment: pending.registrationCommitment,
      }),
    );
  });
});
