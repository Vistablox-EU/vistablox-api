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

// Phase 7: origination's own event-driven local copy of KycEligibility,
// replacing a live cross-schema Prisma read against identity's own table
// (docs/kyc-eligibility-read-model.md). Combines read (KycEligibilityReader,
// unchanged from origination's perspective -- PrismaOriginationRepository's
// own call site doesn't change at all) and write (applyEvent/reconcile) in
// one class, mirroring PrismaKycRepository's own precedent of combining
// both for one table.
export class PrismaOriginationKycProjectionRepository implements KycEligibilityReader {
  public constructor(private readonly database: DatabaseClient) {}

  public async getEligibilitySnapshot(
    accountId: string,
  ): Promise<KycEligibilitySnapshot | null> {
    return this.database.originationKycEligibilityProjection.findUnique({
      where: { accountId },
      select: SNAPSHOT_SELECT,
    });
  }

  // Applied by worker.ts's subscriber to identity.kyc_eligibility_changed --
  // one event, one row, always a write (an upsert is never a no-op), so
  // {checked: 1, acted: 1} always, matching JobRunSummary's shape so this
  // fits the same runJob wrapper every other scheduled job here uses.
  public async applyEvent(snapshot: KycEligibilitySnapshot): Promise<JobRunSummary> {
    const { accountId, ...fields } = snapshot;
    await this.database.originationKycEligibilityProjection.upsert({
      where: { accountId },
      create: { accountId, ...fields, projectionUpdatedAt: new Date() },
      update: { ...fields, projectionUpdatedAt: new Date() },
    });
    return { checked: 1, acted: 1 };
  }

  // Full sync from identity.kyc_eligibility (the one retained, deliberate
  // exception to "this module never reads identity's tables directly" --
  // see docs/kyc-eligibility-read-model.md) into this projection: cold-start
  // backfill on an empty table, and the ongoing staleness backstop
  // otherwise. Diff-then-write, not blind upsert-everything -- otherwise
  // `acted` would just equal `checked` on every run, and a frequent
  // reconcile cadence (offering's own copy of this class runs every 5
  // minutes) would be needlessly expensive instead of mostly reads.
  public async reconcile(): Promise<JobRunSummary> {
    const [sourceRows, projectionRows] = await Promise.all([
      this.database.kycEligibility.findMany({ select: SNAPSHOT_SELECT }),
      this.database.originationKycEligibilityProjection.findMany({ select: SNAPSHOT_SELECT }),
    ]);
    const projectionByAccountId = new Map(
      projectionRows.map((row) => [row.accountId, row]),
    );
    let acted = 0;
    for (const source of sourceRows) {
      const existing = projectionByAccountId.get(source.accountId);
      if (existing !== undefined && snapshotFieldsEqual(existing, source)) continue;
      const { accountId, ...fields } = source;
      await this.database.originationKycEligibilityProjection.upsert({
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
