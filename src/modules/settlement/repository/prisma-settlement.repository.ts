import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
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

  public async recordEscrowMintedPosition(
    input: RecordEscrowMintedPositionInput,
  ): Promise<{ positionId: string }> {
    return this.database.$transaction(async (transaction) => {
      const position = await transaction.positionLedger.create({
        data: {
          id: `position_${ulid()}`,
          // No reservationId: this position originated directly from an
          // on-chain escrow contribution (AD-256), not the onramp/
          // reconfirmation reservation flow (AD-146/AD-214).
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
