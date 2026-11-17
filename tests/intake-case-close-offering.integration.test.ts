import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaIntakeRepository } from "../src/modules/intake/repository/prisma-intake.repository.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import type { OfferingCursor } from "../src/modules/offering/repository/offering.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// Issue #165: closing an intake case from pre_offering_open must close its offering in the same transaction, so the
// offering leaves the public listing and stops accepting reservations, and its open reservations are cancelled.
describe.skipIf(databaseUrl === undefined)("intake case close closes its pre-offering PostgreSQL integration", () => {
  const suffix = randomUUID();
  const applicantAccountId = `acct_close_applicant_${suffix}`;
  const investorAccountId = `acct_close_investor_${suffix}`;
  const staffAccountId = `acct_close_staff_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  // PgBoss validates its connection string in the constructor, so it is built in beforeAll, not at describe scope.
  let boss: PgBoss;
  let intakeRepository: PrismaIntakeRepository;
  let offeringRepository: PrismaOfferingRepository;
  const caseIds: string[] = [];
  const offeringIds: string[] = [];

  async function createAccount(accountId: string, label: string): Promise<void> {
    const betterAuthUserId = `auth_${accountId}`;
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, label, `${accountId}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
  }

  async function createCase(stage: string): Promise<{ caseId: string; propertyId: string }> {
    const id = randomUUID();
    const caseId = `case_close_${id}`;
    const propertyId = `property_close_${id}`;
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "RS",
        city: "Belgrade",
        addressLine: "Case Close Test 1",
        ownerDeclaredValueEur: "300000.00",
      },
    });
    await database.intakeCase.create({
      data: {
        id: caseId,
        propertyId,
        applicantAccountId,
        stage,
        ipoEndAt: new Date("2099-12-31T00:00:00.000Z"),
        legalExecutionEventRefs: [],
        legalDocumentRefs: [],
        appraisalDocumentRefs: [],
      },
    });
    caseIds.push(caseId);
    return { caseId, propertyId };
  }

  async function openOffering(caseId: string, propertyId: string): Promise<string> {
    const opened = await offeringRepository.openOfferingForApprovedCase({
      caseId,
      propertyId,
      ipoValueEur: "1000.00",
      traceId: `trace_open_${suffix}`,
      openedAt: new Date(),
      openEscrowCampaign: false,
    });
    offeringIds.push(opened.offeringId);
    return opened.offeringId;
  }

  async function reserve(offeringId: string, amountEur: string) {
    return offeringRepository.createReservation({
      reservationId: `reservation_${randomUUID()}`,
      offeringId,
      accountId: investorAccountId,
      amountEur,
      disclosurePackVersionAtReservation: null,
      traceId: `trace_reserve_${suffix}`,
      createdAt: new Date(),
    });
  }

  async function publicOfferingIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    let after: OfferingCursor | undefined;
    for (;;) {
      const page = await offeringRepository.listPublic({ limit: 200, ...(after === undefined ? {} : { after }) });
      for (const offering of page) {
        ids.add(offering.id);
      }
      const last = page.at(-1);
      if (page.length < 200 || last === undefined) {
        return ids;
      }
      after = { featured: last.featured, createdAt: last.createdAt, id: last.id };
    }
  }

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    const kycRepository = new PrismaKycRepository(database, boss);
    intakeRepository = new PrismaIntakeRepository(database, boss, kycRepository);
    offeringRepository = new PrismaOfferingRepository(database, boss, kycRepository);
    await boss.start();
    await createAccount(applicantAccountId, "Case Close Applicant");
    await createAccount(investorAccountId, "Case Close Investor");
    await createAccount(staffAccountId, "Case Close Staff");
  }, 30_000);

  afterAll(async () => {
    // Reservations write append-only money events with RESTRICT foreign keys, so the reservations, offerings, cases and
    // accounts stay behind (every id is unique per run). Only the audit rows are removed.
    await database.auditLog.deleteMany({
      where: { resourceId: { in: [...caseIds, ...offeringIds] } },
    });
    await database.auditLog.deleteMany({
      where: { resourceType: "reservation", actorAccountId: investorAccountId },
    });
    await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
  });

  it.each([
    {
      outcome: "rejected" as const,
      extra: { rejectionReasonCode: "valuation_mismatch", rejectionNotes: "Appraisal does not support the value." },
    },
    { outcome: "withdrawn" as const, extra: {} },
  ])("closing a pre_offering_open case as $outcome closes its offering and cancels open reservations", async ({ outcome, extra }) => {
    const { caseId, propertyId } = await createCase("pre_offering_open");
    const offeringId = await openOffering(caseId, propertyId);
    const before = await reserve(offeringId, "400.00");
    expect(before.conflict).toBeNull();
    const reservationId = before.reservation!.reservationId;
    expect(await publicOfferingIds()).toContain(offeringId);

    const closed = await intakeRepository.closeCase({
      outcome,
      accountId: staffAccountId,
      caseId,
      traceId: `trace_close_${suffix}`,
      founderReviewNotes: "Closing the case.",
      closedAt: new Date(),
      ...extra,
    } as Parameters<PrismaIntakeRepository["closeCase"]>[0]);

    expect(closed).toMatchObject({ caseId, stage: outcome });
    expect(await database.offering.findUniqueOrThrow({ where: { id: offeringId } })).toMatchObject({ status: "closed" });
    expect(await publicOfferingIds()).not.toContain(offeringId);
    expect(await reserve(offeringId, "100.00")).toEqual({ conflict: "offering_not_open", reservation: null, reused: false });
    expect(await database.reservation.findUniqueOrThrow({ where: { id: reservationId } })).toMatchObject({
      reservationStage: "cancelled",
    });
    const audit = await database.auditLog.findFirstOrThrow({
      where: { resourceId: offeringId, action: "offering.closed_with_case" },
    });
    expect(audit.changes).toMatchObject({
      case_id: caseId,
      case_outcome: outcome,
      new_status: "closed",
      cancelled_reservation_ids: [reservationId],
    });
  }, 30_000);

  it("an approval handoff that runs after the case was closed opens the offering already closed", async () => {
    const { caseId, propertyId } = await createCase("pre_offering_open");
    await intakeRepository.closeCase({
      outcome: "withdrawn",
      accountId: staffAccountId,
      caseId,
      traceId: `trace_close_${suffix}`,
      founderReviewNotes: "Withdrawn before the handoff ran.",
      closedAt: new Date(),
    });

    const offeringId = await openOffering(caseId, propertyId);

    expect(await database.offering.findUniqueOrThrow({ where: { id: offeringId } })).toMatchObject({ status: "closed" });
    expect(await publicOfferingIds()).not.toContain(offeringId);
    expect(await reserve(offeringId, "100.00")).toEqual({ conflict: "offering_not_open", reservation: null, reused: false });
  }, 30_000);
});
