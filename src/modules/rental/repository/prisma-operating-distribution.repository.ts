import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  ActivePositionHolder,
  CreateOperatingDistributionInput,
  ExistingOperatingDistribution,
  OperatingDistributionRepository,
  RecordRentCollectionInput,
  RentCollectionRecord,
} from "./operating-distribution.repository.js";

// active-only: a pending_internal_settlement position isn't on-chain yet and
// a redeemed one no longer holds units -- neither is entitled to this period's
// distribution.
const ACTIVE_POSITION_STATUS = "active";

export class PrismaOperatingDistributionRepository implements OperatingDistributionRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async listRentCollectionsAwaitingDistribution(): Promise<RentCollectionRecord[]> {
    const records = await this.database.rentCollection.findMany({
      where: { distribution: null },
    });
    return records.map(toRentCollectionRecord);
  }

  public async findRentCollection(input: {
    pivId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<RentCollectionRecord | null> {
    const record = await this.database.rentCollection.findUnique({
      where: {
        pivId_periodStart_periodEnd: {
          pivId: input.pivId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        },
      },
    });
    return record === null ? null : toRentCollectionRecord(record);
  }

  public async recordRentCollection(input: RecordRentCollectionInput): Promise<RentCollectionRecord> {
    const record = await this.database.rentCollection.create({
      data: {
        id: `rntcol_${ulid()}`,
        pivId: input.pivId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        grossRentCollectedEur: input.grossRentCollectedEur,
        recordedBy: input.recordedBy,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
    });
    return toRentCollectionRecord(record);
  }

  public async listActivePositionHolders(pivId: string): Promise<ActivePositionHolder[]> {
    const positions = await this.database.positionLedger.findMany({
      where: { pivId, positionStatus: ACTIVE_POSITION_STATUS },
      select: { id: true, unitCount: true, holderWalletAddress: true },
    });
    return positions.map((position) => ({
      positionId: position.id,
      unitCount: position.unitCount.toString(),
      walletAddress: position.holderWalletAddress,
    }));
  }

  public async findDistribution(input: {
    pivId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<ExistingOperatingDistribution | null> {
    const record = await this.database.operatingDistribution.findUnique({
      where: {
        pivId_periodStart_periodEnd: {
          pivId: input.pivId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
        },
      },
      select: {
        id: true,
        distributableNetEur: true,
        amountPerUnitEur: true,
        _count: { select: { entries: true } },
      },
    });
    if (record === null) return null;
    return {
      id: record.id,
      distributableNetEur: record.distributableNetEur.toString(),
      amountPerUnitEur: record.amountPerUnitEur.toString(),
      entryCount: record._count.entries,
    };
  }

  public async createOperatingDistribution(
    input: CreateOperatingDistributionInput,
  ): Promise<{ id: string }> {
    const distributionId = `opdist_${ulid()}`;
    await this.database.$transaction(async (tx) => {
      await tx.operatingDistribution.create({
        data: {
          id: distributionId,
          pivId: input.pivId,
          rentCollectionId: input.rentCollectionId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          recordDate: input.recordDate,
          grossRentEur: input.grossRentEur,
          managementFeeEur: input.managementFeeEur,
          otherExpensesEur: input.otherExpensesEur,
          reserveHoldbackEur: input.reserveHoldbackEur,
          distributableNetEur: input.distributableNetEur,
          totalUnitsAtRecordDate: input.totalUnitsAtRecordDate,
          amountPerUnitEur: input.amountPerUnitEur,
        },
      });
      if (input.entries.length > 0) {
        await tx.operatingDistributionEntry.createMany({
          data: input.entries.map((entry) => ({
            id: `opdistentry_${ulid()}`,
            operatingDistributionId: distributionId,
            positionId: entry.positionId,
            unitCountAtRecordDate: entry.unitCountAtRecordDate,
            amountEurc: entry.amountEurc,
            destinationWalletAddress: entry.destinationWalletAddress,
          })),
        });
      }
    });
    return { id: distributionId };
  }
}

function toRentCollectionRecord(record: {
  id: string;
  pivId: string;
  periodStart: Date;
  periodEnd: Date;
  grossRentCollectedEur: { toString(): string };
  recordedBy: string;
}): RentCollectionRecord {
  return {
    id: record.id,
    pivId: record.pivId,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    grossRentCollectedEur: record.grossRentCollectedEur.toString(),
    recordedBy: record.recordedBy,
  };
}
