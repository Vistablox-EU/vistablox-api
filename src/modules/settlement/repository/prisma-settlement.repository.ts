import { ulid } from "ulid";

import type { Prisma } from "../../../generated/prisma/client.js";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { isUniqueViolationOf } from "../../../infrastructure/database/unique-violation.js";
import {
  normalizeChainHash,
  type WalletRegistrationEvidence,
  type WalletRegistrationEvidenceFlag,
} from "../../../shared/domain/wallet-registration-evidence.js";
import type {
  CreateEscrowMintIntentInput,
  EscrowMintIntent,
  EscrowMintIntentStatus,
  PivPendingEscrowResolution,
  PivTokenHolding,
  PivTokenHoldingsReader,
  RecordEscrowMintedPositionInput,
  SettlementRepository,
  WalletRegistrationAddressMismatchInput,
  WalletRegistrationConfirmation,
  WalletRegistrationEvidenceKey,
  WalletRegistrationEvidenceReplacement,
  WalletRegistrationRecheckCandidate,
  WalletRegistrationRecord,
} from "./settlement.repository.js";

// Reuses the generic platform.settings key-value table (PlatformSetting)
// rather than a bespoke single-row table -- there is exactly one watermark
// value to persist and this table already exists for exactly this kind of
// thing.
const WALLET_REGISTRY_CURSOR_SETTING_KEY = "wallet_registry.last_processed_block";

// The partial unique index on (registration_tx_hash, registration_log_index):
// an on-chain event backs at most one registration. Named so a violation of it
// is told apart from any other unique constraint the same UPDATE can meet.
const CHAIN_EVENT_UNIQUE_INDEX = "uq_wallet_registrations_chain_event";

const WALLET_REGISTRATION_RECORD_SELECT = {
  accountId: true,
  walletAddress: true,
  registeredAt: true,
  registrationTxHash: true,
  registrationBlockNumber: true,
  registrationBlockHash: true,
  registrationLogIndex: true,
  registrationEvidenceFlag: true,
} as const;

interface WalletRegistrationRecordRow {
  accountId: string;
  walletAddress: string;
  registeredAt: Date | null;
  registrationTxHash: string | null;
  registrationBlockNumber: bigint | null;
  registrationBlockHash: string | null;
  registrationLogIndex: number | null;
  registrationEvidenceFlag: string | null;
}

function toWalletRegistrationRecord(row: WalletRegistrationRecordRow): WalletRegistrationRecord {
  return {
    accountId: row.accountId,
    walletAddress: row.walletAddress,
    registeredAt: row.registeredAt,
    transactionHash: row.registrationTxHash,
    blockNumber: row.registrationBlockNumber,
    blockHash: row.registrationBlockHash,
    logIndex: row.registrationLogIndex,
    // The evidence_state_check constraint is what guarantees this cast.
    evidenceFlag: row.registrationEvidenceFlag as WalletRegistrationEvidenceFlag | null,
  };
}

function holdsKey(row: WalletRegistrationRecordRow, key: WalletRegistrationEvidenceKey): boolean {
  const same = (stored: string | null, expected: string | null) =>
    stored === null || expected === null ? stored === expected : stored.toLowerCase() === expected.toLowerCase();
  return (
    same(row.registrationTxHash, key.transactionHash) &&
    same(row.registrationBlockHash, key.blockHash) &&
    row.registrationLogIndex === key.logIndex
  );
}

function evidenceColumns(evidence: WalletRegistrationEvidence) {
  // The repository is the persistence boundary: it stores the one spelling the
  // CHECK constraint accepts whatever the caller passed.
  return {
    registrationTxHash: normalizeChainHash(evidence.transactionHash),
    registrationBlockNumber: evidence.blockNumber,
    registrationBlockHash: normalizeChainHash(evidence.blockHash),
    registrationLogIndex: evidence.logIndex,
  };
}

function evidenceForAudit(evidence: {
  transactionHash: string | null;
  blockHash: string | null;
  blockNumber: bigint | null;
  logIndex: number | null;
}) {
  return {
    tx_hash: evidence.transactionHash,
    block_hash: evidence.blockHash,
    block_number: evidence.blockNumber?.toString() ?? null,
    log_index: evidence.logIndex,
  };
}

// Takes the row lock a compare-and-set that also writes an audit row needs, so
// the values read for the audit are the values the write replaces.
async function lockWalletRegistration(
  transaction: Prisma.TransactionClient,
  accountId: string,
): Promise<WalletRegistrationRecordRow | null> {
  const locked = await transaction.$queryRaw<Array<{ account_id: string }>>`
    SELECT account_id
    FROM settlement.wallet_registrations
    WHERE account_id = ${accountId}
    FOR UPDATE
  `;
  if (locked.length === 0) return null;
  return transaction.walletRegistration.findUnique({
    where: { accountId },
    select: WALLET_REGISTRATION_RECORD_SELECT,
  });
}

interface EscrowMintIntentRow {
  id: string;
  pivId: string;
  accountId: string;
  holderWalletAddress: string;
  tokenContractAddress: string;
  tokenId: { toFixed(decimalPlaces: number): string };
  mintAmount: { toFixed(decimalPlaces: number): string };
  status: string;
  mintTxHash: string | null;
  attempt: number;
  attemptedAt: Date;
  searchFromBlock: bigint | null;
}

function toEscrowMintIntent(row: EscrowMintIntentRow): EscrowMintIntent {
  return {
    id: row.id,
    pivId: row.pivId,
    accountId: row.accountId,
    walletAddress: row.holderWalletAddress,
    tokenContractAddress: row.tokenContractAddress,
    tokenId: row.tokenId.toFixed(0),
    mintAmount: BigInt(row.mintAmount.toFixed(0)),
    // The status CHECK constraint is what guarantees this cast.
    status: row.status as EscrowMintIntentStatus,
    mintTxHash: row.mintTxHash,
    attempt: row.attempt,
    attemptedAt: row.attemptedAt,
    searchFromBlock: row.searchFromBlock,
  };
}

export class PrismaSettlementRepository implements SettlementRepository, PivTokenHoldingsReader {
  public constructor(private readonly database: DatabaseClient) {}

  public async findPivsWithPassedIpoDeadline(now: Date): Promise<PivPendingEscrowResolution[]> {
    const rows = await this.database.piv.findMany({
      where: {
        tokenId: { not: null },
        case: { ipoEndAt: { lte: now } },
      },
      select: { id: true, tokenId: true },
    });
    return rows.map((row) => ({ pivId: row.id, tokenId: row.tokenId!.toFixed(0) }));
  }

  public async resolveAccountIdForWallet(walletAddress: string): Promise<string | null> {
    // Case-insensitive: nothing in the registration path (register-wallet.service.ts)
    // normalizes casing, so this can't assume it matches an on-chain
    // contributor address's (typically EIP-55 checksummed) casing.
    const registration = await this.database.walletRegistration.findFirst({
      where: { walletAddress: { equals: walletAddress, mode: "insensitive" } },
      select: { accountId: true },
    });
    return registration?.accountId ?? null;
  }

  public async hasPosition(pivId: string, accountId: string): Promise<boolean> {
    const existing = await this.database.positionLedger.findFirst({
      where: { pivId, accountId },
      select: { id: true },
    });
    return existing !== null;
  }

  public async listTokenHoldings(accountId: string): Promise<PivTokenHolding[]> {
    const positions = await this.database.positionLedger.findMany({
      where: { accountId, piv: { tokenId: { not: null } } },
      select: { piv: { select: { id: true, tokenId: true } } },
      distinct: ["pivId"],
    });
    return positions.map((position) => ({
      pivId: position.piv.id,
      tokenId: position.piv.tokenId!.toFixed(0),
    }));
  }

  public async findEscrowMintIntent(pivId: string, accountId: string): Promise<EscrowMintIntent | null> {
    const row = await this.database.escrowMintIntent.findUnique({
      where: { pivId_accountId: { pivId, accountId } },
    });
    return row === null ? null : toEscrowMintIntent(row);
  }

  public async createEscrowMintIntent(
    input: CreateEscrowMintIntentInput,
  ): Promise<{ intent: EscrowMintIntent; created: boolean }> {
    // ON CONFLICT DO NOTHING on uq_escrow_mint_intents_piv_account: when two
    // runs race to claim the same contributor, exactly one inserts.
    const inserted = await this.database.escrowMintIntent.createMany({
      data: [
        {
          id: `escrow_mint_${ulid()}`,
          pivId: input.pivId,
          accountId: input.accountId,
          holderWalletAddress: input.walletAddress,
          tokenContractAddress: input.tokenContractAddress,
          tokenId: input.tokenId,
          mintAmount: input.mintAmount.toString(),
          status: "sending",
          attempt: 1,
          attemptedAt: input.attemptedAt,
          searchFromBlock: input.searchFromBlock,
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.database.escrowMintIntent.findUniqueOrThrow({
      where: { pivId_accountId: { pivId: input.pivId, accountId: input.accountId } },
    });
    return { intent: toEscrowMintIntent(row), created: inserted.count === 1 };
  }

  public async restartEscrowMintAttempt(input: {
    intentId: string;
    expectedAttempt: number;
    attemptedAt: Date;
  }): Promise<boolean> {
    const updated = await this.database.escrowMintIntent.updateMany({
      where: { id: input.intentId, attempt: input.expectedAttempt, status: { in: ["sending", "mint_sent"] } },
      data: {
        status: "sending",
        mintTxHash: null,
        attempt: { increment: 1 },
        attemptedAt: input.attemptedAt,
      },
    });
    return updated.count === 1;
  }

  public async recordEscrowMintSent(input: {
    intentId: string;
    attempt: number;
    txHash: string;
  }): Promise<void> {
    const updated = await this.database.escrowMintIntent.updateMany({
      where: { id: input.intentId, attempt: input.attempt, status: "sending" },
      data: { status: "mint_sent", mintTxHash: input.txHash },
    });
    if (updated.count === 1) return;

    const current = await this.database.escrowMintIntent.findUnique({
      where: { id: input.intentId },
      select: { attempt: true, mintTxHash: true },
    });
    if (current !== null && current.attempt === input.attempt && current.mintTxHash === input.txHash) {
      return; // Idempotent replay of the same hash on the same attempt.
    }
    throw new Error(
      `escrow mint intent ${input.intentId} is not at attempt ${input.attempt} in 'sending'; ` +
        `cannot record mint tx ${input.txHash}`,
    );
  }

  public async recordEscrowMintedPosition(
    input: RecordEscrowMintedPositionInput,
  ): Promise<{ positionId: string }> {
    return this.database.$transaction(async (transaction) => {
      // The intent flips to `recorded` in the same transaction as the
      // position and event rows, so there is no moment at which the position
      // exists and the intent still says otherwise (or the reverse). Only the
      // transaction that wins this flip writes the position; one that loses it
      // (a replay, or an overlapping run) finds the position already there.
      const flipped = await transaction.escrowMintIntent.updateMany({
        where: { id: input.escrowMintIntentId, status: "mint_sent", mintTxHash: input.chainTxHash },
        data: { status: "recorded", recordedAt: input.activatedAt },
      });
      if (flipped.count === 0) {
        const existing = await transaction.positionLedger.findUnique({
          where: { escrowMintIntentId: input.escrowMintIntentId },
          select: { id: true },
        });
        if (existing !== null) return { positionId: existing.id };
        throw new Error(
          `escrow mint intent ${input.escrowMintIntentId} is not in 'mint_sent' with tx ${input.chainTxHash}; ` +
            "refusing to record a position for it",
        );
      }

      const position = await transaction.positionLedger.create({
        data: {
          id: `position_${ulid()}`,
          // No reservationId: this position originated directly from an
          // on-chain escrow contribution (AD-256), not the onramp/
          // reconfirmation reservation flow (AD-146/AD-214).
          escrowMintIntentId: input.escrowMintIntentId,
          pivId: input.pivId,
          accountId: input.accountId,
          unitCount: input.unitCount,
          costBasisEur: input.costBasisEur,
          positionStatus: "active",
          holderWalletAddress: input.walletAddress,
          activatedAt: input.activatedAt,
        },
        select: { id: true },
      });
      await transaction.chainSettlementEvent.create({
        data: {
          id: `chain_event_${ulid()}`,
          positionId: position.id,
          eventType: "mint",
          tokenContractAddress: input.tokenContractAddress,
          tokenId: input.tokenId,
          chainTxHash: input.chainTxHash,
        },
      });
      return { positionId: position.id };
    });
  }

  public async findWalletRegistrationByCommitment(commitment: string): Promise<WalletRegistrationRecord | null> {
    // Case-insensitive for the same reason resolveAccountIdForWallet is
    // above: nothing guarantees the on-chain event's hex casing matches what
    // was stored when the commitment was generated.
    const row = await this.database.walletRegistration.findFirst({
      where: { registrationCommitment: { equals: commitment, mode: "insensitive" } },
      select: WALLET_REGISTRATION_RECORD_SELECT,
    });
    return row === null ? null : toWalletRegistrationRecord(row);
  }

  public async countPendingWalletRegistrationsBefore(cutoff: Date): Promise<number> {
    return this.database.walletRegistration.count({
      where: { registeredAt: null, requestedAt: { lt: cutoff } },
    });
  }

  public async confirmWalletRegistration(input: {
    accountId: string;
    registeredAt: Date;
    evidence: WalletRegistrationEvidence;
  }): Promise<WalletRegistrationConfirmation> {
    // One statement: registered_at and the event's identity land together or
    // not at all. The registered_at IS NULL predicate is the compare-and-set
    // that makes a second confirmation of the same row a no-op, and it is
    // evaluated under the row lock UPDATE takes, so of several concurrent
    // confirmations exactly one writes (count 1) and the others see count 0.
    try {
      const result = await this.database.walletRegistration.updateMany({
        where: { accountId: input.accountId, registeredAt: null },
        data: { registeredAt: input.registeredAt, ...evidenceColumns(input.evidence) },
      });
      return result.count === 1 ? "confirmed" : "already_registered";
    } catch (error) {
      // Another row already holds this (transaction hash, log index). The
      // statement did not apply, so registered_at and the evidence are still
      // all NULL on this row.
      if (isUniqueViolationOf(error, CHAIN_EVENT_UNIQUE_INDEX)) return "event_taken";
      throw error;
    }
  }

  public async replaceWalletRegistrationEvidence(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    next: WalletRegistrationEvidence;
    reason: "recorded" | "refreshed";
    changedAt: Date;
  }): Promise<WalletRegistrationEvidenceReplacement> {
    try {
      return await this.database.$transaction(async (transaction) => {
        const current = await lockWalletRegistration(transaction, input.accountId);
        if (current === null || current.registeredAt === null || !holdsKey(current, input.expected)) {
          return "stale" as const;
        }
        await transaction.walletRegistration.update({
          where: { accountId: input.accountId },
          data: {
            ...evidenceColumns(input.next),
            registrationEvidenceVerifiedAt: null,
            registrationEvidenceFlaggedAt: null,
            registrationEvidenceFlag: null,
          },
        });
        await transaction.auditLog.create({
          data: {
            id: `audit_${ulid()}`,
            action: `settlement.wallet_registration_evidence_${input.reason}`,
            resourceType: "wallet_registration",
            resourceId: input.accountId,
            changes: {
              previous:
                current.registrationTxHash === null
                  ? null
                  : evidenceForAudit({
                      transactionHash: current.registrationTxHash,
                      blockHash: current.registrationBlockHash,
                      blockNumber: current.registrationBlockNumber,
                      logIndex: current.registrationLogIndex,
                    }),
              next: evidenceForAudit({ ...input.next, transactionHash: normalizeChainHash(input.next.transactionHash), blockHash: normalizeChainHash(input.next.blockHash) }),
              previous_flag: current.registrationEvidenceFlag,
            },
            createdAt: input.changedAt,
          },
        });
        return "replaced" as const;
      });
    } catch (error) {
      // Raised outside the transaction on purpose: a failed statement aborts
      // the Postgres transaction, so there is nothing to continue inside it.
      if (isUniqueViolationOf(error, CHAIN_EVENT_UNIQUE_INDEX)) return "event_taken";
      throw error;
    }
  }

  public async markWalletRegistrationEvidenceVerified(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    verifiedAt: Date;
  }): Promise<boolean> {
    const result = await this.database.walletRegistration.updateMany({
      where: {
        accountId: input.accountId,
        registeredAt: { not: null },
        registrationTxHash: input.expected.transactionHash,
        registrationBlockHash: input.expected.blockHash,
        registrationLogIndex: input.expected.logIndex,
        registrationEvidenceVerifiedAt: null,
        registrationEvidenceFlaggedAt: null,
      },
      data: { registrationEvidenceVerifiedAt: input.verifiedAt },
    });
    return result.count === 1;
  }

  public async flagWalletRegistrationEvidence(input: {
    accountId: string;
    expected: WalletRegistrationEvidenceKey;
    flag: WalletRegistrationEvidenceFlag;
    flaggedAt: Date;
  }): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const current = await lockWalletRegistration(transaction, input.accountId);
      if (
        current === null ||
        current.registeredAt === null ||
        current.registrationBlockHash === null ||
        current.registrationEvidenceFlag !== null ||
        !holdsKey(current, input.expected)
      ) {
        return false;
      }
      // registered_at is deliberately not touched: the registration was proven
      // by the wallet's signature; a flag only says the recorded event is gone.
      await transaction.walletRegistration.update({
        where: { accountId: input.accountId },
        data: { registrationEvidenceFlaggedAt: input.flaggedAt, registrationEvidenceFlag: input.flag },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          action: "settlement.wallet_registration_evidence_flagged",
          resourceType: "wallet_registration",
          resourceId: input.accountId,
          changes: {
            flag: input.flag,
            ...evidenceForAudit({
              transactionHash: current.registrationTxHash,
              blockHash: current.registrationBlockHash,
              blockNumber: current.registrationBlockNumber,
              logIndex: current.registrationLogIndex,
            }),
          },
          createdAt: input.flaggedAt,
        },
      });
      return true;
    });
  }

  public async listWalletRegistrationsForEvidenceRecheck(
    limit: number,
  ): Promise<WalletRegistrationRecheckCandidate[]> {
    // Matches idx_wallet_registrations_evidence_recheck (partial, ordered by
    // block number) exactly.
    const rows = await this.database.walletRegistration.findMany({
      where: {
        registrationBlockHash: { not: null },
        registrationEvidenceVerifiedAt: null,
        registrationEvidenceFlaggedAt: null,
      },
      orderBy: { registrationBlockNumber: "asc" },
      take: limit,
      select: {
        accountId: true,
        walletAddress: true,
        registrationCommitment: true,
        registrationTxHash: true,
        registrationBlockNumber: true,
        registrationBlockHash: true,
        registrationLogIndex: true,
      },
    });
    const candidates: WalletRegistrationRecheckCandidate[] = [];
    for (const row of rows) {
      // The shape check keeps these four together; the guard is for a row the
      // constraint was never validated against.
      if (
        row.registrationTxHash === null ||
        row.registrationBlockHash === null ||
        row.registrationBlockNumber === null ||
        row.registrationLogIndex === null
      ) {
        continue;
      }
      candidates.push({
        accountId: row.accountId,
        walletAddress: row.walletAddress,
        registrationCommitment: row.registrationCommitment,
        evidence: {
          transactionHash: row.registrationTxHash,
          blockHash: row.registrationBlockHash,
          blockNumber: row.registrationBlockNumber,
          logIndex: row.registrationLogIndex,
        },
      });
    }
    return candidates;
  }

  public async getLastProcessedWalletRegistryBlock(): Promise<bigint | null> {
    const setting = await this.database.platformSetting.findUnique({
      where: { key: WALLET_REGISTRY_CURSOR_SETTING_KEY },
      select: { value: true },
    });
    return setting === null ? null : BigInt(setting.value as string);
  }

  public async setLastProcessedWalletRegistryBlock(block: bigint): Promise<void> {
    await this.database.platformSetting.upsert({
      where: { key: WALLET_REGISTRY_CURSOR_SETTING_KEY },
      create: {
        key: WALLET_REGISTRY_CURSOR_SETTING_KEY,
        value: block.toString(),
        description:
          "Last block number processed by the VistaBloxWalletRegistry WalletRegistered event watcher (AD-241).",
      },
      update: { value: block.toString() },
    });
  }

  public async recordWalletRegistrationAddressMismatch(
    input: WalletRegistrationAddressMismatchInput,
  ): Promise<void> {
    // No actorAccountId: this fires from the worker's own event watcher, not
    // a staff action -- there's no acting account to attribute it to.
    await this.database.auditLog.create({
      data: {
        id: `audit_${ulid()}`,
        action: "settlement.wallet_registration_address_mismatch",
        resourceType: "wallet_registration",
        resourceId: input.accountId,
        changes: {
          commitment: input.commitment,
          stored_wallet_address: input.storedWalletAddress,
          onchain_sender: input.onChainSender,
        },
        createdAt: input.detectedAt,
      },
    });
  }
}
