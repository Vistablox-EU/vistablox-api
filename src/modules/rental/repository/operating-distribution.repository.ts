// Money and unit-count fields are decimal strings throughout this module,
// matching operating-distribution.policy.ts's convention -- converting to
// `number` anywhere on this boundary would silently reintroduce the
// floating-point precision loss that module was built to avoid.

export interface RecordRentCollectionInput {
  pivId: string;
  periodStart: Date;
  periodEnd: Date;
  grossRentCollectedEur: string;
  recordedBy: string;
  notes?: string;
}

export interface RentCollectionRecord {
  id: string;
  pivId: string;
  periodStart: Date;
  periodEnd: Date;
  grossRentCollectedEur: string;
  recordedBy: string;
}

export interface ActivePositionHolder {
  positionId: string;
  unitCount: string;
  // Null when the investor hasn't registered a self-custody wallet yet
  // (AD-240) -- the caller must skip these rather than fail the whole run.
  walletAddress: string | null;
}

export interface CreateOperatingDistributionInput {
  pivId: string;
  rentCollectionId: string;
  periodStart: Date;
  periodEnd: Date;
  recordDate: Date;
  grossRentEur: string;
  managementFeeEur: string;
  otherExpensesEur: string;
  reserveHoldbackEur: string;
  distributableNetEur: string;
  totalUnitsAtRecordDate: string;
  amountPerUnitEur: string;
  entries: {
    positionId: string;
    unitCountAtRecordDate: string;
    amountEurc: string;
    destinationWalletAddress: string;
  }[];
}

export interface ExistingOperatingDistribution {
  id: string;
  distributableNetEur: string;
  amountPerUnitEur: string;
  entryCount: number;
}

export interface OperatingDistributionRepository {
  /**
   * Idempotent on (pivId, periodStart, periodEnd) -- a retried request for
   * a period already recorded returns the existing row rather than
   * throwing, matching the pattern pg-boss's own createQueue already uses
   * elsewhere in this codebase.
   */
  /**
   * Rent collections already recorded (by whatever staff-facing process
   * enters a contracted property manager's report, AD-236) that have no
   * corresponding distribution yet -- the monthly job's actual work list.
   * This never invents a gross-rent figure; it only converts what someone
   * already entered.
   */
  listRentCollectionsAwaitingDistribution(): Promise<RentCollectionRecord[]>;

  findRentCollection(input: {
    pivId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<RentCollectionRecord | null>;

  recordRentCollection(input: RecordRentCollectionInput): Promise<RentCollectionRecord>;

  /**
   * Active positions only (pending_internal_settlement and redeemed
   * positions are excluded) -- a position isn't entitled to a distribution
   * until it's on-chain, and a redeemed position no longer holds units.
   */
  listActivePositionHolders(pivId: string): Promise<ActivePositionHolder[]>;

  findDistribution(input: {
    pivId: string;
    periodStart: Date;
    periodEnd: Date;
  }): Promise<ExistingOperatingDistribution | null>;

  /**
   * Writes the distribution and all its entries in one transaction --
   * either the whole period's distribution is recorded or none of it is,
   * never a partial set of entries a retry could double up on.
   */
  createOperatingDistribution(input: CreateOperatingDistributionInput): Promise<{ id: string }>;
}
