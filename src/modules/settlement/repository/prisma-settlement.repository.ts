import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  CreateEscrowMintIntentInput,
  EscrowMintIntent,
  EscrowMintIntentStatus,
  PendingWalletRegistration,
  PivPendingEscrowResolution,
  PivTokenHolding,
  PivTokenHoldingsReader,
  RecordEscrowMintedPositionInput,
  SettlementRepository,
  WalletRegistrationAddressMismatchInput,
} from "./settlement.repository.js";

// Reuses the generic platform.settings key-value table (PlatformSetting)
// rather than a bespoke single-row table -- there is exactly one watermark
// value to persist and this table already exists for exactly this kind of
// thing.
const WALLET_REGISTRY_CURSOR_SETTING_KEY = "wallet_registry.last_processed_block";

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

  public async findPendingWalletRegistrationByCommitment(
    commitment: string,
  ): Promise<PendingWalletRegistration | null> {
    // Case-insensitive for the same reason resolveAccountIdForWallet is
    // above: nothing guarantees the on-chain event's hex casing matches what
    // was stored when the commitment was generated.
    return this.database.walletRegistration.findFirst({
      where: { registrationCommitment: { equals: commitment, mode: "insensitive" }, registeredAt: null },
      select: { accountId: true, walletAddress: true },
    });
  }

  public async countPendingWalletRegistrationsBefore(cutoff: Date): Promise<number> {
    return this.database.walletRegistration.count({
      where: { registeredAt: null, requestedAt: { lt: cutoff } },
    });
  }

  public async confirmWalletRegistration(accountId: string, registeredAt: Date): Promise<void> {
    await this.database.walletRegistration.update({
      where: { accountId },
      data: { registeredAt },
    });
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
