import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { isUniqueViolation } from "../../../infrastructure/database/unique-violation.js";
import {
  normalizeChainHash,
  type WalletRegistrationEvidenceFlag,
} from "../../../shared/domain/wallet-registration-evidence.js";
import {
  WalletAddressConflictError,
  type ReconcileWalletRegistrationInput,
  type ReconcileWalletRegistrationResult,
  type RegisteredWallet,
  type WalletRepository,
  type WalletStatusReader,
  type WalletStatusSnapshot,
} from "./wallet.repository.js";

// See PrismaSettlementRepository: the partial unique index that lets an
// on-chain event back at most one registration.
const CHAIN_EVENT_UNIQUE_INDEX = "uq_wallet_registrations_chain_event";

const REGISTERED_WALLET_SELECT = {
  walletAddress: true,
  registrationCommitment: true,
  requestedAt: true,
  registeredAt: true,
  registrationTxHash: true,
  registrationBlockNumber: true,
  registrationBlockHash: true,
  registrationLogIndex: true,
  registrationEvidenceVerifiedAt: true,
  registrationEvidenceFlaggedAt: true,
  registrationEvidenceFlag: true,
} as const;

interface RegisteredWalletRow {
  walletAddress: string;
  registrationCommitment: string;
  requestedAt: Date;
  registeredAt: Date | null;
  registrationTxHash: string | null;
  registrationBlockNumber: bigint | null;
  registrationBlockHash: string | null;
  registrationLogIndex: number | null;
  registrationEvidenceVerifiedAt: Date | null;
  registrationEvidenceFlaggedAt: Date | null;
  registrationEvidenceFlag: string | null;
}

function toRegisteredWallet(row: RegisteredWalletRow): RegisteredWallet {
  return {
    ...row,
    // The evidence_state_check constraint is what guarantees this cast.
    registrationEvidenceFlag: row.registrationEvidenceFlag as WalletRegistrationEvidenceFlag | null,
  };
}

export class PrismaWalletRepository implements WalletRepository, WalletStatusReader {
  public constructor(private readonly database: DatabaseClient) {}

  public async registerWallet(input: {
    accountId: string;
    walletAddress: string;
    registrationCommitment: string;
    requestedAt: Date;
  }): Promise<RegisteredWallet> {
    return this.database.$transaction(async (transaction) => {
      const existingForAccount = await transaction.walletRegistration.findUnique({
        where: { accountId: input.accountId },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
          registrationTxHash: true,
          registrationBlockNumber: true,
        },
      });
      if (existingForAccount !== null && existingForAccount.walletAddress === input.walletAddress) {
        // Idempotent replay of the same request: return the existing
        // registration rather than creating a second one.
        return existingForAccount;
      }

      // Checked before the account's own existing-registration state: if
      // this exact address already belongs to a *different* account, that's
      // the more specific conflict, regardless of whether the requesting
      // account also happens to already have a different address of its
      // own. Checking address_mismatch first would misreport a genuine
      // address-uniqueness violation as "you're trying to change your own
      // address" whenever both conditions happen to be true at once.
      const claimedByOther = await transaction.walletRegistration.findUnique({
        where: { walletAddress: input.walletAddress },
        select: { accountId: true },
      });
      if (claimedByOther !== null && claimedByOther.accountId !== input.accountId) {
        throw new WalletAddressConflictError("address_claimed");
      }

      if (existingForAccount !== null) {
        throw new WalletAddressConflictError("address_mismatch");
      }

      const created = await transaction.walletRegistration.create({
        data: {
          accountId: input.accountId,
          walletAddress: input.walletAddress,
          registrationCommitment: input.registrationCommitment,
          requestedAt: input.requestedAt,
        },
        select: {
          walletAddress: true,
          registrationCommitment: true,
          requestedAt: true,
          registeredAt: true,
          registrationTxHash: true,
          registrationBlockNumber: true,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "settlement.wallet_registration_requested",
          resourceType: "account",
          resourceId: input.accountId,
          changes: { wallet_address: input.walletAddress },
          createdAt: input.requestedAt,
        },
      });
      return created;
    });
  }

  public async getStatus(accountId: string): Promise<WalletStatusSnapshot | null> {
    return this.database.walletRegistration.findUnique({
      where: { accountId },
      select: { requestedAt: true, registeredAt: true },
    });
  }

  public async findByAccountId(accountId: string): Promise<RegisteredWallet | null> {
    const row = await this.database.walletRegistration.findUnique({
      where: { accountId },
      select: REGISTERED_WALLET_SELECT,
    });
    return row === null ? null : toRegisteredWallet(row);
  }

  public async reconcileWalletRegistration(
    input: ReconcileWalletRegistrationInput,
  ): Promise<ReconcileWalletRegistrationResult> {
    const evidence = {
      transactionHash: normalizeChainHash(input.evidence.transactionHash),
      blockHash: normalizeChainHash(input.evidence.blockHash),
      blockNumber: input.evidence.blockNumber,
      logIndex: input.evidence.logIndex,
    };
    const evidenceData = {
      registrationTxHash: evidence.transactionHash,
      registrationBlockNumber: evidence.blockNumber,
      registrationBlockHash: evidence.blockHash,
      registrationLogIndex: evidence.logIndex,
    };
    const nextForAudit = {
      tx_hash: evidence.transactionHash,
      block_hash: evidence.blockHash,
      block_number: evidence.blockNumber.toString(),
      log_index: evidence.logIndex,
    };

    try {
      return await this.database.$transaction(async (transaction): Promise<ReconcileWalletRegistrationResult> => {
        // The row is locked for the decision: the watcher confirms and
        // refreshes the same row, and two staff reconciles can race. What is
        // read here is what the write below replaces.
        const locked = await transaction.$queryRaw<Array<{ account_id: string }>>`
          SELECT account_id
          FROM settlement.wallet_registrations
          WHERE account_id = ${input.accountId}
          FOR UPDATE
        `;
        if (locked.length === 0) return { kind: "not_found" };
        const row = await transaction.walletRegistration.findUniqueOrThrow({
          where: { accountId: input.accountId },
          select: REGISTERED_WALLET_SELECT,
        });

        const audit = (action: string, changes: Record<string, unknown>) =>
          transaction.auditLog.create({
            data: {
              id: `audit_${ulid()}`,
              actorAccountId: input.actorAccountId,
              action,
              resourceType: "wallet_registration",
              resourceId: input.accountId,
              changes: changes as object,
              createdAt: input.changedAt,
            },
          });

        // A pending row: the reconcile is the confirmation. registered_at is
        // written here and nowhere else in this method.
        if (row.registeredAt === null) {
          const updated = await transaction.walletRegistration.update({
            where: { accountId: input.accountId },
            data: { registeredAt: input.registeredAt, ...evidenceData },
            select: REGISTERED_WALLET_SELECT,
          });
          await audit("settlement.wallet_registration_reconciled", {
            ...nextForAudit,
            registered_at: input.registeredAt.toISOString(),
          });
          return { kind: "reconciled", outcome: "confirmed", wallet: toRegisteredWallet(updated) };
        }

        const storedTransaction = row.registrationTxHash?.toLowerCase() ?? null;
        const sameTransaction = storedTransaction === evidence.transactionHash;
        const complete = row.registrationBlockHash !== null && row.registrationLogIndex !== null && storedTransaction !== null;
        const flagged = row.registrationEvidenceFlaggedAt !== null;

        let outcome: "evidence_recorded" | "evidence_replaced";
        if (complete) {
          const identical =
            sameTransaction &&
            row.registrationBlockHash!.toLowerCase() === evidence.blockHash &&
            row.registrationLogIndex === evidence.logIndex;
          if (identical && !flagged) {
            return { kind: "reconciled", outcome: "unchanged", wallet: toRegisteredWallet(row) };
          }
          // The same transaction mined again, or a flagged row: staff has
          // verified an event on the chain for this wallet and commitment, so
          // it replaces the recorded one. A different event for a row that is
          // not flagged is left alone.
          if (!sameTransaction && !flagged) return { kind: "conflict", reason: "different_event" };
          outcome = "evidence_replaced";
        } else if (storedTransaction === null || sameTransaction) {
          // Confirmed before evidence was kept, or with a transaction hash and
          // block number only: fill it in.
          outcome = "evidence_recorded";
        } else {
          return { kind: "conflict", reason: "different_event" };
        }

        const updated = await transaction.walletRegistration.update({
          where: { accountId: input.accountId },
          data: {
            ...evidenceData,
            registrationEvidenceVerifiedAt: null,
            registrationEvidenceFlaggedAt: null,
            registrationEvidenceFlag: null,
          },
          select: REGISTERED_WALLET_SELECT,
        });
        await audit(`settlement.wallet_registration_${outcome === "evidence_recorded" ? "evidence_recorded" : "evidence_replaced"}`, {
          previous:
            row.registrationTxHash === null
              ? null
              : {
                  tx_hash: row.registrationTxHash,
                  block_hash: row.registrationBlockHash,
                  block_number: row.registrationBlockNumber?.toString() ?? null,
                  log_index: row.registrationLogIndex,
                },
          next: nextForAudit,
          previous_flag: row.registrationEvidenceFlag,
        });
        return { kind: "reconciled", outcome, wallet: toRegisteredWallet(updated) };
      });
    } catch (error) {
      // Outside the transaction on purpose: a failed statement aborts it. The
      // whole reconcile rolled back, so nothing was written.
      if (isUniqueViolation(error, CHAIN_EVENT_UNIQUE_INDEX)) return { kind: "conflict", reason: "event_taken" };
      throw error;
    }
  }
}
