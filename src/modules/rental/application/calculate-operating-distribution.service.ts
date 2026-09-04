import {
  computeAmountPerUnit,
  computeDistributableNet,
  computeEntryAmount,
} from "../domain/operating-distribution.policy.js";
import type { OperatingDistributionRepository } from "../repository/operating-distribution.repository.js";

export interface CalculateOperatingDistributionInput {
  pivId: string;
  periodStart: Date;
  periodEnd: Date;
  grossRentCollectedEur: string;
  managementFeeEur: string;
  otherExpensesEur: string;
  reserveHoldbackEur: string;
  recordedBy: string;
  notes?: string;
}

export interface CalculateOperatingDistributionResult {
  operatingDistributionId: string;
  distributableNetEur: string;
  amountPerUnitEur: string;
  entriesCreated: number;
  // Active holders whose position exists but who have no registered
  // self-custody wallet yet (AD-240) -- entitled to this period's
  // distribution but not paid it. What happens to their share once they do
  // register a wallet (a catch-up payment, vs. rolled into the next period)
  // isn't designed yet; surfaced here rather than silently decided either
  // way. Not counted in entriesCreated.
  skippedNoWalletPositionIds: string[];
  alreadyCalculated: boolean;
}

/**
 * Computes one PIV's operating distribution for one period and persists it
 * at `calculated` status -- nothing here pays out. See
 * operating_distributions.approved_at in the schema for the governance
 * checkpoint required before any entry moves toward payment, and
 * settlement/README or ON_CHAIN_SETTLEMENT.md for why VistaBlox proposes a
 * payout but the governed issuer multisig is what actually executes it.
 */
export class CalculateOperatingDistributionService {
  public constructor(
    private readonly repository: OperatingDistributionRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(
    input: CalculateOperatingDistributionInput,
  ): Promise<CalculateOperatingDistributionResult> {
    const existingDistribution = await this.repository.findDistribution({
      pivId: input.pivId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });
    if (existingDistribution !== null) {
      // Idempotent re-run (a retried request, a re-triggered job): return
      // what's already there rather than recomputing or double-inserting.
      return {
        operatingDistributionId: existingDistribution.id,
        distributableNetEur: existingDistribution.distributableNetEur,
        amountPerUnitEur: existingDistribution.amountPerUnitEur,
        entriesCreated: existingDistribution.entryCount,
        skippedNoWalletPositionIds: [],
        alreadyCalculated: true,
      };
    }

    let rentCollection = await this.repository.findRentCollection({
      pivId: input.pivId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    });
    if (rentCollection === null) {
      rentCollection = await this.repository.recordRentCollection({
        pivId: input.pivId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        grossRentCollectedEur: input.grossRentCollectedEur,
        recordedBy: input.recordedBy,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      });
    }

    const distributableNetEur = computeDistributableNet({
      grossRentEur: input.grossRentCollectedEur,
      managementFeeEur: input.managementFeeEur,
      otherExpensesEur: input.otherExpensesEur,
      reserveHoldbackEur: input.reserveHoldbackEur,
    });

    const holders = await this.repository.listActivePositionHolders(input.pivId);
    const totalUnits = holders
      .reduce((sum, holder) => sum + BigInt(toMicroUnits(holder.unitCount)), 0n);
    const totalUnitsStr = fromMicroUnits(totalUnits);

    const skippedNoWalletPositionIds: string[] = [];
    let entries: {
      positionId: string;
      unitCountAtRecordDate: string;
      amountEurc: string;
      destinationWalletAddress: string;
    }[] = [];

    // A period with no active holders yet (a property finalized but not
    // funded/activated) has nothing to divide by -- record the zero-holder
    // state rather than dividing by zero.
    const amountPerUnitEur =
      totalUnits > 0n
        ? computeAmountPerUnit({ distributableNetEur, totalUnits: totalUnitsStr })
        : "0.000000";

    if (totalUnits > 0n) {
      entries = holders
        .filter((holder) => {
          if (holder.walletAddress === null) {
            skippedNoWalletPositionIds.push(holder.positionId);
            return false;
          }
          return true;
        })
        .map((holder) => ({
          positionId: holder.positionId,
          unitCountAtRecordDate: holder.unitCount,
          amountEurc: computeEntryAmount({
            unitCount: holder.unitCount,
            amountPerUnitEur,
          }),
          destinationWalletAddress: holder.walletAddress as string,
        }));
    }

    const recordDate = input.periodEnd;
    const { id } = await this.repository.createOperatingDistribution({
      pivId: input.pivId,
      rentCollectionId: rentCollection.id,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      recordDate,
      grossRentEur: input.grossRentCollectedEur,
      managementFeeEur: input.managementFeeEur,
      otherExpensesEur: input.otherExpensesEur,
      reserveHoldbackEur: input.reserveHoldbackEur,
      distributableNetEur,
      totalUnitsAtRecordDate: totalUnitsStr,
      amountPerUnitEur,
      entries,
    });

    return {
      operatingDistributionId: id,
      distributableNetEur,
      amountPerUnitEur,
      entriesCreated: entries.length,
      skippedNoWalletPositionIds,
      alreadyCalculated: false,
    };
  }
}

// Local micro-unit helpers (6-decimal), mirroring operating-distribution.policy.ts's
// convention -- kept private to this file since summing unit counts across
// many holders is this service's own concern, not a general-purpose export.
const MICROS_PER_UNIT = 1_000_000n;

function toMicroUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * MICROS_PER_UNIT + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

function fromMicroUnits(value: bigint): string {
  const whole = value / MICROS_PER_UNIT;
  const fraction = (value % MICROS_PER_UNIT).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}
