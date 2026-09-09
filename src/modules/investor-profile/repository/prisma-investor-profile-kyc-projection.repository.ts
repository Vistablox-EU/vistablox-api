import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import type {
  KycEligibilityReader,
  KycEligibilitySnapshot,
} from "../../identity/repository/kyc-eligibility-reader.js";

const SNAPSHOT_SELECT = {
  accountId: true,
  diditReference: true,
  providerStatus: true,
  eligibilityState: true,
  residenceCountryCode: true,
  taxResidenceCountryCode: true,
  proofOfAddressStatus: true,
  proofOfAddressCurrentUntil: true,
  lastVerifiedAt: true,
  renewalDueAt: true,
} as const;

// Phase 7: investor-profile's own event-driven local copy of
// KycEligibility -- mirrors PrismaOriginationKycProjectionRepository
// exactly (see its own comments for the full reasoning). The underlying
// table lives in the "account" Prisma schema, not a dedicated
// investor-profile one -- investor-profile has never had a schema of its
// own (docs/investor-profile.md), and "account" was the closest existing
// affinity when this table needed a schema home.
export class PrismaInvestorProfileKycProjectionRepository implements KycEligibilityReader {
  public constructor(private readonly database: DatabaseClient) {}

  public async getEligibilitySnapshot(
    accountId: string,
  ): Promise<KycEligibilitySnapshot | null> {
    return this.database.investorProfileKycEligibilityProjection.findUnique({
      where: { accountId },
      select: SNAPSHOT_SELECT,
    });
  }

  public async applyEvent(snapshot: KycEligibilitySnapshot): Promise<JobRunSummary> {
    const { accountId, ...fields } = snapshot;
    await this.database.investorProfileKycEligibilityProjection.upsert({
      where: { accountId },
      create: { accountId, ...fields, projectionUpdatedAt: new Date() },
      update: { ...fields, projectionUpdatedAt: new Date() },
    });
    return { checked: 1, acted: 1 };
  }

  public async reconcile(): Promise<JobRunSummary> {
    const [sourceRows, projectionRows] = await Promise.all([
      this.database.kycEligibility.findMany({ select: SNAPSHOT_SELECT }),
      this.database.investorProfileKycEligibilityProjection.findMany({ select: SNAPSHOT_SELECT }),
    ]);
    const projectionByAccountId = new Map(
      projectionRows.map((row) => [row.accountId, row]),
    );
    let acted = 0;
    for (const source of sourceRows) {
      const existing = projectionByAccountId.get(source.accountId);
      if (existing !== undefined && snapshotFieldsEqual(existing, source)) continue;
      const { accountId, ...fields } = source;
      await this.database.investorProfileKycEligibilityProjection.upsert({
        where: { accountId },
        create: { accountId, ...fields, projectionUpdatedAt: new Date() },
        update: { ...fields, projectionUpdatedAt: new Date() },
      });
      acted += 1;
    }
    return { checked: sourceRows.length, acted };
  }
}

function snapshotFieldsEqual(
  a: Omit<KycEligibilitySnapshot, "accountId">,
  b: Omit<KycEligibilitySnapshot, "accountId">,
): boolean {
  return (
    a.diditReference === b.diditReference &&
    a.providerStatus === b.providerStatus &&
    a.eligibilityState === b.eligibilityState &&
    a.residenceCountryCode === b.residenceCountryCode &&
    a.taxResidenceCountryCode === b.taxResidenceCountryCode &&
    a.proofOfAddressStatus === b.proofOfAddressStatus &&
    datesEqual(a.proofOfAddressCurrentUntil, b.proofOfAddressCurrentUntil) &&
    datesEqual(a.lastVerifiedAt, b.lastVerifiedAt) &&
    datesEqual(a.renewalDueAt, b.renewalDueAt)
  );
}

function datesEqual(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}
