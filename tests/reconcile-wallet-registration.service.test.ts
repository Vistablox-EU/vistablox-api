import { describe, expect, it, vi } from "vitest";

import {
  ReconcileWalletRegistrationService,
  WalletRegistrationVerificationError,
  type VerifiedWalletRegistration,
  type WalletRegistrationVerificationFailure,
} from "../src/modules/wallet/application/reconcile-wallet-registration.service.js";
import type {
  ReconcileWalletRegistrationResult,
  RegisteredWallet,
  WalletRepository,
} from "../src/modules/wallet/repository/wallet.repository.js";
import { AppError } from "../src/shared/errors/app-error.js";

const NOW = new Date("2026-11-13T12:00:00.000Z");
const TX = `0x${"bb".repeat(32)}`;
const BLOCK = `0x${"aa".repeat(32)}`;
const REGISTERED_AT = new Date("2026-01-01T00:01:00Z");

const pending: RegisteredWallet = {
  walletAddress: "0x1111111111111111111111111111111111111111",
  registrationCommitment: `0x${"AA".repeat(32)}`,
  requestedAt: new Date("2026-01-01T00:00:00Z"),
  registeredAt: null,
};
const withEvidence: RegisteredWallet = {
  ...pending,
  registeredAt: new Date("2026-01-01T00:00:30Z"),
  registrationTxHash: TX,
  registrationBlockNumber: 12n,
  registrationBlockHash: BLOCK,
  registrationLogIndex: 2,
  registrationEvidenceVerifiedAt: null,
  registrationEvidenceFlaggedAt: null,
  registrationEvidenceFlag: null,
};
const verified: VerifiedWalletRegistration = {
  transactionHash: TX,
  blockHash: BLOCK,
  blockNumber: 12n,
  logIndex: 2,
  registeredAt: REGISTERED_AT,
};

function build(options: {
  wallet?: RegisteredWallet | null;
  result?: ReconcileWalletRegistrationResult;
  verify?: () => Promise<VerifiedWalletRegistration>;
  withoutReconcile?: boolean;
}) {
  const reconcile = vi.fn(
    async (): Promise<ReconcileWalletRegistrationResult> =>
      options.result ?? { kind: "reconciled", outcome: "confirmed", wallet: { ...withEvidence, registeredAt: REGISTERED_AT } },
  );
  const repository: WalletRepository = {
    registerWallet: vi.fn(),
    findByAccountId: vi.fn(async () => (options.wallet === undefined ? pending : options.wallet)),
    ...(options.withoutReconcile ? {} : { reconcileWalletRegistration: reconcile }),
  };
  const verifier = { verify: vi.fn(options.verify ?? (async () => verified)) };
  const service = new ReconcileWalletRegistrationService(repository, verifier, () => NOW);
  return { service, repository, verifier, reconcile };
}

const run = (service: ReconcileWalletRegistrationService, txHash = TX) =>
  service.execute({ accountId: "acct_1", actorAccountId: "staff_1", txHash });

async function appErrorOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error("expected an AppError");
}

describe("ReconcileWalletRegistrationService", () => {
  it("verifies the chain evidence with lower-cased inputs, then records it and reports the outcome", async () => {
    const { service, verifier, reconcile } = build({});

    const result = await run(service, `0x${"BB".repeat(32)}`);

    expect(verifier.verify).toHaveBeenCalledWith({
      txHash: TX,
      walletAddress: pending.walletAddress,
      commitment: pending.registrationCommitment.toLowerCase(),
    });
    expect(reconcile).toHaveBeenCalledWith({
      accountId: "acct_1",
      actorAccountId: "staff_1",
      evidence: { transactionHash: TX, blockHash: BLOCK, blockNumber: 12n, logIndex: 2 },
      registeredAt: REGISTERED_AT,
      changedAt: NOW,
    });
    expect(result).toEqual({
      data: {
        account_id: "acct_1",
        wallet_address: pending.walletAddress,
        status: "registered",
        registration_tx_hash: TX,
        registration_block_number: "12",
        registration_block_hash: BLOCK,
        registration_log_index: 2,
        outcome: "confirmed",
        requested_at: "2026-01-01T00:00:00.000Z",
        registered_at: REGISTERED_AT.toISOString(),
      },
    });
  });

  it("answers from the row, without a chain call, when it already holds a complete record of this transaction", async () => {
    const { service, verifier, reconcile } = build({ wallet: withEvidence });

    const result = await run(service, `0x${"BB".repeat(32)}`);

    expect(verifier.verify).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      outcome: "unchanged",
      registration_tx_hash: TX,
      registration_block_hash: BLOCK,
      registration_log_index: 2,
      registered_at: withEvidence.registeredAt!.toISOString(),
    });
  });

  it.each([
    ["has no evidence", { ...withEvidence, registrationTxHash: null, registrationBlockNumber: null, registrationBlockHash: null, registrationLogIndex: null }],
    ["has a transaction hash and block number only", { ...withEvidence, registrationBlockHash: null, registrationLogIndex: null }],
    ["is flagged", { ...withEvidence, registrationEvidenceFlaggedAt: NOW, registrationEvidenceFlag: "transaction_missing" as const }],
    ["holds another transaction", { ...withEvidence, registrationTxHash: `0x${"cc".repeat(32)}` }],
  ])("goes to the chain when the registered row %s", async (_label, wallet) => {
    const { service, verifier, reconcile } = build({
      wallet,
      result: { kind: "reconciled", outcome: "evidence_replaced", wallet: withEvidence },
    });

    const result = await run(service);

    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(result.data.outcome).toBe("evidence_replaced");
    // registered_at is the row's, not the event's timestamp.
    expect(result.data.registered_at).toBe(withEvidence.registeredAt!.toISOString());
  });

  it("404s for an account with no registration, before any chain call", async () => {
    const { service, verifier } = build({ wallet: null });

    const error = await appErrorOf(run(service));

    expect(error).toMatchObject({ status: 404, code: "wallet.account_not_found" });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("404s when the row disappears between the read and the write", async () => {
    const { service } = build({ result: { kind: "not_found" } });
    expect(await appErrorOf(run(service))).toMatchObject({ status: 404, code: "wallet.account_not_found" });
  });

  it("answers 503 when this deployment has no reconcile repository, instead of an unexpected error", async () => {
    const { service, verifier } = build({ withoutReconcile: true });

    const error = await appErrorOf(run(service));

    expect(error).toMatchObject({ status: 503, code: "wallet.reconciliation_unavailable" });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["transaction_not_found", 422, "wallet.registration_transaction_not_found"],
    ["transaction_reverted", 422, "wallet.registration_transaction_reverted"],
    ["event_not_found", 422, "wallet.registration_event_not_found"],
    ["not_sufficiently_confirmed", 409, "wallet.registration_transaction_unconfirmed"],
    ["chain_unavailable", 503, "wallet.chain_unavailable"],
  ] satisfies Array<[WalletRegistrationVerificationFailure, number, string]>)(
    "maps the verifier's %s to %i %s and writes nothing",
    async (reason, status, code) => {
      const { service, reconcile } = build({
        verify: async () => {
          throw new WalletRegistrationVerificationError(reason, { cause: new Error("https://rpc.example/secret-key") });
        },
      });

      const error = await appErrorOf(run(service));

      expect(error).toMatchObject({ status, code });
      expect(reconcile).not.toHaveBeenCalled();
      // The RPC URL a viem error carries stays in the cause, never in the response.
      expect(error.message).not.toContain("secret-key");
      expect(error.type).toContain(code);
    },
  );

  it("does not put the commitment in the event-not-found response", async () => {
    const { service } = build({
      verify: async () => {
        throw new WalletRegistrationVerificationError("event_not_found");
      },
    });

    const error = await appErrorOf(run(service));

    expect(error.message.toLowerCase()).not.toContain(pending.registrationCommitment.toLowerCase());
    expect(error.message).not.toContain(pending.walletAddress);
  });

  it("lets an error that is not a verification failure through as it is", async () => {
    const { service } = build({
      verify: async () => {
        throw new TypeError("bug");
      },
    });
    await expect(run(service)).rejects.toThrow(TypeError);
  });

  it.each([
    ["different_event", "wallet.registration_evidence_conflict"],
    ["event_taken", "wallet.registration_event_already_used"],
  ] as const)("answers 409 %s as %s", async (reason, code) => {
    const { service } = build({ result: { kind: "conflict", reason } });

    const error = await appErrorOf(run(service));

    expect(error).toMatchObject({ status: 409, code });
  });
});
