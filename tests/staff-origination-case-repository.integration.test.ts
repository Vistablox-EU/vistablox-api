import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import {
  ApplicantAccountNotFoundError,
} from "../src/modules/origination/repository/origination.repository.js";
import { PrismaOriginationRepository } from "../src/modules/origination/repository/prisma-origination.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "staff-created origination case PostgreSQL integration",
  () => {
    const suffix = randomUUID();
    const applicantAccountId = `acct_applicant_${suffix}`;
    const applicantAuthId = `auth_applicant_${suffix}`;
    const staffAccountId = `acct_staff_${suffix}`;
    const staffAuthId = `auth_staff_${suffix}`;
    const sharedEmail = `Shared-${suffix}@example.test`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    let boss: PgBoss;
    let originationRepository: PrismaOriginationRepository;
    const accountRepository = new PrismaAccountRepository(database);
    let createdCaseId = "";

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      const kycRepository = new PrismaKycRepository(database, boss);
      originationRepository = new PrismaOriginationRepository(database, boss, kycRepository);

      for (const [id, authId, email] of [
        [applicantAccountId, applicantAuthId, sharedEmail],
        [staffAccountId, staffAuthId, `staff-${suffix}@example.test`],
      ] as const) {
        await authPool.query(
          'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
          [authId, "Staff Case Test User", `${authId}@example.test`, true, "customer"],
        );
        await database.account.create({
          data: { id, betterAuthUserId: authId, protectedContactEmail: email },
        });
      }
      await database.platformSetting.upsert({
        where: { key: "origination.minimum_property_value_eur" },
        update: {},
        create: {
          key: "origination.minimum_property_value_eur",
          value: { amount: "150000.00", currency: "EUR" },
          description: "Test fixture floor",
        },
      });
    }, 30_000);

    afterAll(async () => {
      await database.auditLog.deleteMany({
        where: { OR: [{ resourceId: createdCaseId }, { actorAccountId: staffAccountId }] },
      });
      // submission_revisions is append-only (AD-186's trigger rejects UPDATE
      // and DELETE unconditionally), and its FKs to origination_cases and
      // accounts are ON DELETE RESTRICT, and accounts -> auth_user is
      // RESTRICT too -- so once the first test creates a real revision, the
      // case, its property, the applicant account, and both auth_user rows
      // all become permanently undeletable. Same tradeoff
      // origination-offering-handoff.integration.test.ts already accepts:
      // clean up only what's actually deletable (audit rows above), and
      // leave the rest.
      await Promise.all([database.$disconnect(), authPool.end(), boss.stop({ graceful: false })]);
    });

    it("creates a submitted case with a real revision in one transaction, attributed to the staff caller", async () => {
      const created = await originationRepository.createStaffCase({
        applicantAccountId,
        staffAccountId,
        traceId: `trace_${suffix}`,
        property: {
          countryCode: "RS",
          city: "Belgrade",
          addressLine: "Staff Intake Test 1",
          landRegistryReference: `BG-${suffix}`,
          ownerDeclaredValueEur: "200000.00",
          hasExistingEncumbrance: false,
          residentialSubtype: "apartment",
          livingAreaSqM: 82.5,
          bedrooms: 2,
          bathrooms: 1,
          floor: 3,
          totalFloors: 6,
          yearBuilt: 1998,
          condition: "good",
          energyRating: "C",
        },
        submissionData: { attestations: { staff_created: true } },
        documents: [
          { documentType: "ownership_declaration", documentRef: "doc-owner", extractDated: null },
          { documentType: "property_facts_sheet", documentRef: "doc-facts", extractDated: null },
          { documentType: "encumbrance_declaration", documentRef: "doc-enc", extractDated: null },
          { documentType: "photo_set", documentRef: "doc-photos", extractDated: null },
        ],
      });
      createdCaseId = created.caseId;

      expect(created).toMatchObject({
        revisionNumber: 1,
        stage: "submitted",
        applicantAccountId,
      });

      const originationCase = await database.originationCase.findUniqueOrThrow({
        where: { id: created.caseId },
      });
      expect(originationCase.stage).toBe("submitted");
      expect(originationCase.applicantAccountId).toBe(applicantAccountId);
      expect(originationCase.currentSubmissionRevisionId).toBe(created.revisionId);

      const revision = await database.submissionRevision.findUniqueOrThrow({
        where: { id: created.revisionId },
      });
      expect(revision.reason).toBe("initial_staff_created");
      expect(revision.submittedByAccountId).toBe(staffAccountId);

      const evidence = await database.documentaryScreeningEvidence.findMany({
        where: { caseId: created.caseId },
      });
      expect(evidence).toHaveLength(4);
      expect(evidence.every((item) => item.status === "pending")).toBe(true);

      const audit = await database.auditLog.findFirst({
        where: { action: "origination.case_created_by_staff", resourceId: created.caseId },
      });
      expect(audit?.actorAccountId).toBe(staffAccountId);
      expect(audit?.changes).toMatchObject({
        applicant_account_id: applicantAccountId,
        staff_actor_account_id: staffAccountId,
      });

      const property = await database.property.findUniqueOrThrow({
        where: { id: originationCase.propertyId },
      });
      expect(property.residentialSubtype).toBe("apartment");
      expect(property.livingAreaSqM?.toString()).toBe("82.50");
      expect(property.bedrooms).toBe(2);
      expect(property.bathrooms).toBe(1);
      expect(property.floor).toBe(3);
      expect(property.totalFloors).toBe(6);
      expect(property.yearBuilt).toBe(1998);
      expect(property.condition).toBe("good");
      expect(property.energyRating).toBe("C");

      // Round-trips through ownedCaseSelect/toOwnedCase (the same mapper
      // GET /v1/origination-cases/:case_id uses): living_area_sq_m comes
      // back as a plain JS number, not a Prisma.Decimal.
      const owned = await originationRepository.getOwnedCase(applicantAccountId, created.caseId);
      expect(owned?.property).toMatchObject({
        residentialSubtype: "apartment",
        livingAreaSqM: 82.5,
        bedrooms: 2,
        bathrooms: 1,
        floor: 3,
        totalFloors: 6,
        yearBuilt: 1998,
        condition: "good",
        energyRating: "C",
      });
      expect(typeof owned?.property.livingAreaSqM).toBe("number");
    });

    it("refuses an out-of-enum residential_subtype at the database layer, defense-in-depth beneath the Zod schema", async () => {
      const propertyId = `prop_check_${suffix}`;
      await expect(
        database.property.create({
          data: {
            id: propertyId,
            countryCode: "RS",
            ownerDeclaredValueEur: "200000.00",
            residentialSubtype: "castle",
          },
        }),
      ).rejects.toThrow(/properties_residential_subtype_check/);

      await expect(
        database.property.create({
          data: {
            id: propertyId,
            countryCode: "RS",
            ownerDeclaredValueEur: "200000.00",
            energyRating: "Z",
          },
        }),
      ).rejects.toThrow(/properties_energy_rating_check/);
    });

    it("rejects an applicant_account_id that doesn't resolve to a real account, writing nothing", async () => {
      await expect(
        originationRepository.createStaffCase({
          applicantAccountId: `acct_nonexistent_${suffix}`,
          staffAccountId,
          traceId: `trace_${suffix}_missing`,
          property: {
            countryCode: "RS",
            city: null,
            addressLine: null,
            landRegistryReference: null,
            ownerDeclaredValueEur: "200000.00",
            hasExistingEncumbrance: false,
            residentialSubtype: null,
            livingAreaSqM: null,
            bedrooms: null,
            bathrooms: null,
            floor: null,
            totalFloors: null,
            yearBuilt: null,
            condition: null,
            energyRating: null,
          },
          submissionData: { attestations: { staff_created: true } },
          documents: [
            { documentType: "ownership_declaration", documentRef: "doc-owner", extractDated: null },
            { documentType: "property_facts_sheet", documentRef: "doc-facts", extractDated: null },
            { documentType: "encumbrance_declaration", documentRef: "doc-enc", extractDated: null },
            { documentType: "photo_set", documentRef: "doc-photos", extractDated: null },
          ],
        }),
      ).rejects.toThrow(ApplicantAccountNotFoundError);
    });

    it("finds every account sharing an email, case-insensitively, and excludes others", async () => {
      const results = await accountRepository.findByEmail(sharedEmail.toLowerCase());
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ accountId: applicantAccountId, email: sharedEmail });

      const noMatch = await accountRepository.findByEmail(`nobody-${suffix}@example.test`);
      expect(noMatch).toEqual([]);
    });
  },
);
