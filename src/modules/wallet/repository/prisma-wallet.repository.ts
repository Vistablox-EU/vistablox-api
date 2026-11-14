import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { isUniqueViolation } from "../../../infrastructure/database/unique-violation.js";
import {
  normalizeChainHash,
  type WalletRegistrationEvidenceFlag,
} from "../../../shared/domain/wallet-registration-evidence.js";
import {
  WalletAddressConflictError,
  WalletRegistrationChangedError,
  WalletReplacementFreshAuthenticationRequiredError,
  type ReconcileWalletRegistrationInput,
  type ReconcileWalletRegistrationResult,
  type RegisteredWallet,
  type WalletRepository,
  type WalletStatusReader,
  type WalletStatusSnapshot,
} from "./wallet.repository.js";

// The partial unique index created by
// 20261113150200_wallet_claims_confirmed_address_uniqueness:
// UNIQUE (lower(wallet_address)) WHERE registered_at IS NOT NULL.
const CONFIRMED_ADDRESS_INDEX = "wallet_registrations_confirmed_address_key";

// See PrismaSettlementRepository: the partial unique index that lets an
// on-chain event back at most one registration.
const CHAIN_EVENT_UNIQUE_INDEX = "uq_wallet_registrations_chain_event";

// The registration itself, without the evidence columns: what registerWallet
// returns (the evidence is of no use to the client that is registering).
const WALLET_SELECT = {
  walletAddress: true,
  registrationCommitment: true,
  requestedAt: true,
  registeredAt: true,
  registrationTxHash: true,
  registrationBlockNumber: true,
} as const;

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

/**
 * A wallet_registrations row with registered_at NULL is a pending claim: the
 * customer typed an address and nothing has proved they control it. A pending
 * claim is account-scoped. It never blocks another account, and its own
 * account may replace it with a different address, provided the caller's
 * session is fresh (see registerWallet). Only a CONFIRMED row binds
 * an address to an account, and the database enforces that through the
 * partial unique index above. Every address comparison is lower(col) =
 * lower($x) so rows written before the canonical lowercase form still match.
 */
export class PrismaWalletRepository implements WalletRepository, WalletStatusReader {
  public constructor(private readonly database: DatabaseClient) {}

  public async registerWallet(input: {
    accountId: string;
    walletAddress: string;
    registrationCommitment: string;
    requestedAt: Date;
    freshAuthentication: boolean;
  }): Promise<RegisteredWallet> {
    const address = input.walletAddress.trim().toLowerCase();
    return this.database.$transaction(async (transaction) => {
      // Two passes: the first can lose the insert race to a concurrent
      // request of the same account (ON CONFLICT DO NOTHING reports 0 rows),
      // in which case the second locks and reads the row that request
      // committed and decides against it.
      for (let pass = 0; pass < 2; pass += 1) {
        // Serialises this account's register/replace with the confirm and
        // reconcile writes, which take the same row lock through UPDATE. A
        // no-op while the account has no row yet.
        await transaction.$queryRaw`
          SELECT 1 FROM settlement.wallet_registrations
          WHERE account_id = ${input.accountId}
          FOR UPDATE
        `;
        const own = await transaction.walletRegistration.findUnique({
          where: { accountId: input.accountId },
          select: WALLET_SELECT,
        });
        // Trim + lower-case on the input, lower-case on the stored side: a case
        // or whitespace variant of the account's own address is a replay of it,
        // never a replacement, so it never needs freshness.
        const ownAddressMatches = own !== null && own.walletAddress.toLowerCase() === address;

        // Replacing the account's own PENDING claim with a different address
        // needs a fresh session. Decided here, under the row lock and on the
        // row just read, so no concurrent request can change the answer
        // between "is this a replacement?" and the write (a peek in the router
        // followed by a write could not promise that). Placed BEFORE the
        // owners query on purpose: the refusal then depends only on this
        // account's own row and this session's freshness, never on another
        // account's addresses, so a session that is not fresh cannot use the
        // replace path to ask which addresses are confirmed elsewhere. Nothing
        // has been written in this pass, and throwing rolls the transaction
        // back: the row, its commitment, requested_at and the audit trail stay
        // exactly as they were, and the refusal itself writes no audit row.
        if (own !== null && own.registeredAt === null && !ownAddressMatches && !input.freshAuthentication) {
          throw new WalletReplacementFreshAuthenticationRequiredError();
        }

        // Only CONFIRMED rows bind an address. Raw SQL rather than Prisma's
        // `mode: insensitive`, which emits ILIKE: wildcard semantics for _
        // and %, and no match for the partial index.
        const owners = await transaction.$queryRaw<Array<{ account_id: string }>>`
          SELECT account_id FROM settlement.wallet_registrations
          WHERE lower(wallet_address) = lower(${address})
            AND registered_at IS NOT NULL
        `;
        const claimedByOther = owners.some((owner) => owner.account_id !== input.accountId);

        // The more specific conflict wins: when the address is confirmed for a
        // different account, report that, even if this account's own
        // registration is also confirmed on another address.
        if (own !== null && own.registeredAt !== null) {
          if (ownAddressMatches) return own; // Idempotent replay of a confirmed registration.
          throw new WalletAddressConflictError(claimedByOther ? "address_claimed" : "address_mismatch");
        }
        // Also covers a replay of a pending claim whose address another
        // account has since confirmed: its commitment is dead, so do not
        // hand it out again.
        if (claimedByOther) throw new WalletAddressConflictError("address_claimed");

        if (own === null) {
          const inserted = await transaction.$executeRaw`
            INSERT INTO settlement.wallet_registrations
              (account_id, wallet_address, registration_commitment, requested_at)
            VALUES
              (${input.accountId}, ${address}, ${input.registrationCommitment}, ${input.requestedAt})
            ON CONFLICT (account_id) DO NOTHING
          `;
          if (inserted === 0) continue; // A concurrent request created the row; decide against it.
          await transaction.auditLog.create({
            data: {
              id: `audit_${ulid()}`,
              actorAccountId: input.accountId,
              action: "settlement.wallet_registration_requested",
              resourceType: "account",
              resourceId: input.accountId,
              changes: { wallet_address: address },
              createdAt: input.requestedAt,
            },
          });
          return transaction.walletRegistration.findUniqueOrThrow({
            where: { accountId: input.accountId },
            select: WALLET_SELECT,
          });
        }

        // Idempotent replay of the same pending claim: keep the commitment
        // the device may already have signed.
        if (ownAddressMatches) return own;

        // A pending claim of this account on another address: replace it in
        // place. The old commitment dies with the overwritten column, so the
        // event watcher can no longer match it.
        const replaced = await transaction.walletRegistration.update({
          where: { accountId: input.accountId, registeredAt: null },
          data: {
            walletAddress: address,
            registrationCommitment: input.registrationCommitment,
            requestedAt: input.requestedAt,
          },
          select: WALLET_SELECT,
        });
        await transaction.auditLog.create({
          data: {
            id: `audit_${ulid()}`,
            actorAccountId: input.accountId,
            action: "settlement.wallet_registration_replaced",
            resourceType: "account",
            resourceId: input.accountId,
            changes: { previous_wallet_address: own.walletAddress, wallet_address: address },
            createdAt: input.requestedAt,
          },
        });
        return replaced;
      }
      // Unreachable: the second pass always finds the row the concurrent
      // request committed, because the lock above waits for it.
      throw new Error("Wallet registration did not settle.");
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
        // refreshes the same row, two staff reconciles can race, and the
        // customer's register call (which replaces a pending claim in place)
        // takes the same lock. What is read here is what the write below
        // replaces.
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

        // Compare-and-set on the identity the chain evidence was verified
        // against (address and commitment, exact). If the account replaced
        // its claim after the caller read it, the unproven new address is not
        // confirmed on the old address's evidence. Deliberately not
        // `registered_at IS NULL`: staff can still attach evidence to a
        // registration the watcher already confirmed. Nothing has been written
        // yet; throwing rolls the transaction back.
        if (
          row.walletAddress !== input.expectedWalletAddress ||
          row.registrationCommitment !== input.expectedRegistrationCommitment
        ) {
          throw new WalletRegistrationChangedError();
        }

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
      if (!isUniqueViolation(error, CONFIRMED_ADDRESS_INDEX)) throw error;
      // Another account confirmed this address first. The violation aborted
      // the transaction above, so the audit row is a separate statement.
      await this.recordConfirmationConflict(input);
      throw new WalletAddressConflictError("address_claimed");
    }
  }

  private async recordConfirmationConflict(input: {
    accountId: string;
    expectedWalletAddress: string;
    actorAccountId: string;
  }): Promise<void> {
    const address = input.expectedWalletAddress.toLowerCase();
    const holders = await this.database.$queryRaw<Array<{ account_id: string }>>`
      SELECT account_id FROM settlement.wallet_registrations
      WHERE lower(wallet_address) = lower(${address})
        AND registered_at IS NOT NULL
        AND account_id <> ${input.accountId}
      LIMIT 1
    `;
    await this.database.auditLog.create({
      data: {
        id: `audit_${ulid()}`,
        actorAccountId: input.actorAccountId,
        action: "settlement.wallet_registration_confirmation_conflict",
        resourceType: "wallet_registration",
        resourceId: input.accountId,
        changes: {
          wallet_address: address,
          holder_account_id: holders[0]?.account_id ?? null,
          source: "manual_reconcile",
        },
      },
    });
  }
}
