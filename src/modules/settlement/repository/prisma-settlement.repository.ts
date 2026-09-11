import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  PivPendingEscrowResolution,
  PivTokenHolding,
  PivTokenHoldingsReader,
  RecordEscrowMintedPositionInput,
  SettlementRepository,
} from "./settlement.repository.js";

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
}
