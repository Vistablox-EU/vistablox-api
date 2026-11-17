import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaOfferingPresentationRepository } from "../src/modules/offering/repository/prisma-offering-presentation.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("offering presentation PostgreSQL integration", () => {
  const suffix = randomUUID();
  const accountId = `account_presentation_${suffix}`;
  const betterAuthUserId = `auth_presentation_${suffix}`;
  const propertyId = `property_presentation_${suffix}`;
  const caseId = `case_presentation_${suffix}`;
  const pivId = `piv_presentation_${suffix}`;
  const offeringId = `offering_presentation_${suffix}`;
  const hero = `https://cdn.example.com/${suffix}/hero.jpg`;
  const gallery = [`https://cdn.example.com/${suffix}/1.jpg`, `https://cdn.example.com/${suffix}/2.jpg`];
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const presentation = new PrismaOfferingPresentationRepository(database);
  // PgBoss validates its connection string in the constructor, so it must not
  // be built at describe-body scope, which runs even when skipIf skips.
  let boss: PgBoss;
  let offerings: PrismaOfferingRepository;

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    offerings = new PrismaOfferingRepository(database, boss, new PrismaKycRepository(database, boss));
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Offering Presentation Operator", `presentation-${suffix}@example.test`, true, "staff_partner"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "DE",
        city: "Leipzig",
        addressLine: "Presentation Test 1",
        ownerDeclaredValueEur: "600000.00",
      },
    });
    await database.intakeCase.create({
      data: {
        id: caseId,
        propertyId,
        applicantAccountId: accountId,
        stage: "approved_for_final_offering",
        legalExecutionEventRefs: [],
        legalDocumentRefs: [],
        appraisalDocumentRefs: [],
        ipoEndAt: new Date("2099-12-31T00:00:00.000Z"),
      },
    });
    await database.piv.create({ data: { id: pivId, propertyId, caseId } });
    await database.offering.create({
      data: { id: offeringId, pivId, minimumRaiseEur: "1000.00", targetRaiseEur: "1000.00", status: "pre_offering" },
    });
  });

  afterAll(async () => {
    await database.auditLog.deleteMany({ where: { resourceType: "offering", resourceId: offeringId } });
    await database.offering.deleteMany({ where: { id: offeringId } });
    await database.piv.deleteMany({ where: { id: pivId } });
    await database.intakeCase.deleteMany({ where: { id: caseId } });
    await database.property.deleteMany({ where: { id: propertyId } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("returns null for an unknown offering without writing an audit row", async () => {
    const missingId = `offering_missing_${suffix}`;
    const result = await presentation.updatePresentation({
      offeringId: missingId,
      featured: true,
      actorAccountId: accountId,
      traceId: "req_missing",
      updatedAt: new Date(),
    });

    expect(result).toBeNull();
    expect(await database.auditLog.count({ where: { resourceId: missingId } })).toBe(0);
  });

  it("stores featured and media, audits the change, and serves media on investor reads", async () => {
    const result = await presentation.updatePresentation({
      offeringId,
      featured: true,
      media: { heroUrl: hero, galleryUrls: gallery },
      actorAccountId: accountId,
      traceId: "req_set",
      updatedAt: new Date(),
    });

    expect(result).toEqual({ featured: true, media: { heroUrl: hero, galleryUrls: gallery } });
    const audit = await database.auditLog.findFirstOrThrow({
      where: { resourceType: "offering", resourceId: offeringId, action: "offering.presentation_updated" },
    });
    expect(audit.actorAccountId).toBe(accountId);
    expect(audit.changes).toEqual({
      trace_id: "req_set",
      before: { featured: false, media: null },
      after: { featured: true, media: { hero_url: hero, gallery_urls: gallery } },
    });

    const detail = await offerings.getInvestorDetail({ offeringId, accountId });
    expect(detail?.property.media).toEqual({ heroUrl: hero, galleryUrls: gallery });

    const listed = await offerings.listPublic({ limit: 100 });
    const row = listed.find((offering) => offering.id === offeringId);
    expect(row?.featured).toBe(true);
    expect(row?.property.media).toEqual({ heroUrl: hero, galleryUrls: gallery });
  });

  it("keeps omitted keys and clears media with null", async () => {
    const result = await presentation.updatePresentation({
      offeringId,
      media: null,
      actorAccountId: accountId,
      traceId: "req_clear",
      updatedAt: new Date(),
    });

    expect(result).toEqual({ featured: true, media: null });
    const stored = await database.offering.findUniqueOrThrow({
      where: { id: offeringId },
      select: { featured: true, heroImageUrl: true, galleryImageUrls: true },
    });
    expect(stored).toEqual({ featured: true, heroImageUrl: null, galleryImageUrls: [] });
    const detail = await offerings.getInvestorDetail({ offeringId, accountId });
    expect(detail?.property.media).toBeNull();
  });
});
