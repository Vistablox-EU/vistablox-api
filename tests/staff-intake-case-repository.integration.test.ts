import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaAccountRepository } from "../src/modules/account/repository/prisma-account.repository.js";
import {
  ApplicantAccountNotFoundError,
  EvidenceCaseMismatchError,
  EvidenceNotFoundError,
} from "../src/modules/intake/repository/intake.repository.js";
import { PrismaIntakeRepository } from "../src/modules/intake/repository/prisma-intake.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "staff-created intake case PostgreSQL integration",
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
    let intakeRepository: PrismaIntakeRepository;
    const accountRepository = new PrismaAccountRepository(database);
    let createdCaseId = "";
    let secondCaseId = "";
    let firstEvidenceId = "";

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      const kycRepository = new PrismaKycRepository(database, boss);
      intakeRepository = new PrismaIntakeRepository(database, boss, kycRepository);

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
        where: { key: "intake.minimum_property_value_eur" },
        update: {},
        create: {
          key: "intake.minimum_property_value_eur",
          value: { amount: "150000.00", currency: "EUR" },
          description: "Test fixture floor",
        },
      });
    }, 30_000);

    afterAll(async () => {
      await database.auditLog.deleteMany({
        where: {
          OR: [
            { resourceId: createdCaseId },
            { resourceId: secondCaseId },
            { actorAccountId: staffAccountId },
          ],
        },
      });
      // submission_revisions is append-only (AD-186's trigger rejects UPDATE
      // and DELETE unconditionally), and its FKs to intake_cases and
      // accounts are ON DELETE RESTRICT, and accounts -> auth_user is
      // RESTRICT too -- so once the first test creates a real revision, the
      // case, its property, the applicant account, and both auth_user rows
      // all become permanently undeletable. Same tradeoff
      // intake-offering-handoff.integration.test.ts already accepts:
      // clean up only what's actually deletable (audit rows above), and
      // leave the rest.
      await Promise.all([database.$disconnect(), authPool.end(), boss.stop({ graceful: false })]);
    });

    it("creates a submitted case with a real revision in one transaction, attributed to the staff caller", async () => {
      const created = await intakeRepository.createStaffCase({
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
          rooms: [
            { roomType: "bedroom", sizeSqM: 14.2 },
            { roomType: "bedroom", sizeSqM: 11.8 },
            { roomType: "bathroom", sizeSqM: 5.5 },
          ],
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

      const intakeCase = await database.intakeCase.findUniqueOrThrow({
        where: { id: created.caseId },
      });
      expect(intakeCase.stage).toBe("submitted");
      expect(intakeCase.applicantAccountId).toBe(applicantAccountId);
      expect(intakeCase.currentSubmissionRevisionId).toBe(created.revisionId);

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
      firstEvidenceId = evidence[0]?.id ?? "";

      const audit = await database.auditLog.findFirst({
        where: { action: "intake.case_created_by_staff", resourceId: created.caseId },
      });
      expect(audit?.actorAccountId).toBe(staffAccountId);
      expect(audit?.changes).toMatchObject({
        applicant_account_id: applicantAccountId,
        staff_actor_account_id: staffAccountId,
      });

      const property = await database.property.findUniqueOrThrow({
        where: { id: intakeCase.propertyId },
      });
      expect(property.residentialSubtype).toBe("apartment");
      expect(property.livingAreaSqM?.toFixed(2)).toBe("82.50");
      expect(property.bedrooms).toBe(2);
      expect(property.bathrooms).toBe(1);
      expect(property.floor).toBe(3);
      expect(property.totalFloors).toBe(6);
      expect(property.yearBuilt).toBe(1998);
      expect(property.condition).toBe("good");
      expect(property.energyRating).toBe("C");

      // Round-trips through ownedCaseSelect/toOwnedCase (the same mapper
      // GET /v1/intake-cases/:case_id uses): living_area_sq_m comes
      // back as a plain JS number, not a Prisma.Decimal.
      const owned = await intakeRepository.getOwnedCase(applicantAccountId, created.caseId);
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

      // orderBy id asc gives a stable order across repeated reads, but NOT
      // necessarily submission order: these ulids were all minted within
      // the same millisecond, and ulid's relative order among same-ms ids
      // is decided by its random component, not generation sequence. So
      // this asserts the row set and each room's shape, not position.
      expect(owned?.property.rooms).toHaveLength(3);
      expect(owned?.property.rooms.map((room) => room.roomType).sort()).toEqual([
        "bathroom",
        "bedroom",
        "bedroom",
      ]);
      expect(owned?.property.rooms.every((room) => typeof room.sizeSqM === "number")).toBe(true);
      expect(owned?.property.rooms.every((room) => room.roomId.startsWith("room_"))).toBe(true);

      const rooms = await database.propertyRoom.findMany({
        where: { propertyId: intakeCase.propertyId },
        orderBy: { id: "asc" },
      });
      expect(rooms).toHaveLength(3);
      expect(rooms.map((room) => room.sizeSqM.toFixed(2)).sort()).toEqual([
        "11.80",
        "14.20",
        "5.50",
      ]);
      // Same order on a second read -- orderBy is deterministic, even if it
      // doesn't track submission order.
      const roomsAgain = await database.propertyRoom.findMany({
        where: { propertyId: intakeCase.propertyId },
        orderBy: { id: "asc" },
      });
      expect(roomsAgain.map((room) => room.id)).toEqual(rooms.map((room) => room.id));
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

      await database.property.create({
        data: { id: propertyId, countryCode: "RS", ownerDeclaredValueEur: "200000.00" },
      });
      await expect(
        database.propertyRoom.create({
          data: {
            id: `room_check_${suffix}`,
            propertyId,
            roomType: "garage",
            sizeSqM: "20.00",
          },
        }),
      ).rejects.toThrow(/property_rooms_room_type_check/);
    });

    it("rejects an applicant_account_id that doesn't resolve to a real account, writing nothing", async () => {
      await expect(
        intakeRepository.createStaffCase({
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
            rooms: [],
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

    it("records a staff review decision on a submitted evidence document", async () => {
      // Guards the dependency on test 1 above having actually set this:
      // an empty id here would make the EvidenceNotFoundError test below
      // pass for the wrong reason (no row matches "") rather than because
      // reviewEvidence itself correctly rejects a missing id.
      expect(firstEvidenceId).not.toBe("");

      const reviewedAt = new Date();
      const reviewed = await intakeRepository.reviewEvidence({
        accountId: staffAccountId,
        caseId: createdCaseId,
        evidenceId: firstEvidenceId,
        traceId: `trace_${suffix}_review`,
        status: "accepted",
        reviewNotes: "Registry extract matches the declared owner.",
        reviewedAt,
      });

      expect(reviewed).toMatchObject({
        evidenceId: firstEvidenceId,
        caseId: createdCaseId,
        status: "accepted",
        reviewedByAccountId: staffAccountId,
        reviewNotes: "Registry extract matches the declared owner.",
      });

      const row = await database.documentaryScreeningEvidence.findUniqueOrThrow({
        where: { id: firstEvidenceId },
      });
      expect(row.status).toBe("accepted");
      expect(row.reviewedByAccountId).toBe(staffAccountId);
      expect(row.reviewNotes).toBe("Registry extract matches the declared owner.");
      expect(row.reviewedAt).not.toBeNull();

      const audit = await database.auditLog.findFirst({
        where: { action: "intake.evidence_reviewed", resourceId: createdCaseId },
      });
      expect(audit?.actorAccountId).toBe(staffAccountId);
      expect(audit?.changes).toMatchObject({
        evidence_id: firstEvidenceId,
        status: "accepted",
      });
    });

    it("throws EvidenceNotFoundError for an evidence id that doesn't exist", async () => {
      await expect(
        intakeRepository.reviewEvidence({
          accountId: staffAccountId,
          caseId: createdCaseId,
          evidenceId: `evidence_missing_${suffix}`,
          traceId: `trace_${suffix}_missing_evidence`,
          status: "accepted",
          reviewNotes: null,
          reviewedAt: new Date(),
        }),
      ).rejects.toThrow(EvidenceNotFoundError);
    });

    it("throws EvidenceCaseMismatchError when the evidence belongs to a different case", async () => {
      await expect(
        intakeRepository.reviewEvidence({
          accountId: staffAccountId,
          caseId: `case_wrong_${suffix}`,
          evidenceId: firstEvidenceId,
          traceId: `trace_${suffix}_mismatched_case`,
          status: "accepted",
          reviewNotes: null,
          reviewedAt: new Date(),
        }),
      ).rejects.toThrow(EvidenceCaseMismatchError);
    });

    // Forces "rejected" with nulled reviewer fields directly, bypassing
    // reviewEvidence entirely -- violates the CHECK regardless of the row's
    // current status (pending or already-reviewed by the test above), so
    // this doesn't actually depend on that test having run first.
    it("refuses a review write inconsistent with documentary_screening_evidence_review_consistency_check, defense-in-depth beneath the service layer", async () => {
      await expect(
        database.documentaryScreeningEvidence.update({
          where: { id: firstEvidenceId },
          data: {
            status: "rejected",
            reviewedByAccountId: null,
            reviewedAt: null,
            reviewNotes: null,
          },
        }),
      ).rejects.toThrow(/documentary_screening_evidence_review_consistency_check/);
    });

    it("finds every account sharing an email, case-insensitively, and excludes others", async () => {
      const results = await accountRepository.findByEmail(sharedEmail.toLowerCase());
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ accountId: applicantAccountId, email: sharedEmail });

      const noMatch = await accountRepository.findByEmail(`nobody-${suffix}@example.test`);
      expect(noMatch).toEqual([]);
    });

    // Manual reminder/force-expire operations routes: getPublishedInformationRequestForTimer
    // (a findFirst scoped to one request) and expireInformationRequest's new
    // optional manualOverride, exercised here against the real case created
    // by the first test above (already "submitted", so it can take a
    // published information request).
    describe("published information request timer methods", () => {
      const publishTraceId = `trace_${suffix}_publish`;
      const publishedAt = new Date();
      const dueAt = new Date(publishedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      let publishedRequestId = "";

      it("publishes a real information request to exercise the timer methods against it", async () => {
        const published = await intakeRepository.publishInformationRequest({
          accountId: staffAccountId,
          caseId: createdCaseId,
          traceId: publishTraceId,
          requestBody: "Please provide a newer land registry extract.",
          publishedAt,
          dueAt,
        });
        expect(published).not.toBeNull();
        publishedRequestId = published?.requestId ?? "";
      });

      it("getPublishedInformationRequestForTimer returns the published request scoped to its case", async () => {
        const found = await intakeRepository.getPublishedInformationRequestForTimer(
          createdCaseId,
          publishedRequestId,
        );
        expect(found).toMatchObject({
          requestId: publishedRequestId,
          caseId: createdCaseId,
          applicantAccountId,
          applicantContactEmail: sharedEmail,
        });
        expect(found?.publishedAt).toBeInstanceOf(Date);
        expect(found?.dueAt).toBeInstanceOf(Date);
      });

      it("getPublishedInformationRequestForTimer returns null when the request isn't under that case", async () => {
        const found = await intakeRepository.getPublishedInformationRequestForTimer(
          `case_wrong_${suffix}`,
          publishedRequestId,
        );
        expect(found).toBeNull();
      });

      it("getPublishedInformationRequestForTimer returns null for a request id that doesn't exist", async () => {
        const found = await intakeRepository.getPublishedInformationRequestForTimer(
          createdCaseId,
          `rfi_missing_${suffix}`,
        );
        expect(found).toBeNull();
      });

      it("expireInformationRequest with manualOverride records manual_override/reason and the staff actor in the audit log", async () => {
        const reason = "Applicant unresponsive after repeated outreach.";
        const expired = await intakeRepository.expireInformationRequest({
          requestId: publishedRequestId,
          caseId: createdCaseId,
          traceId: publishTraceId,
          expiredAt: new Date(),
          manualOverride: { reason, actorAccountId: staffAccountId },
        });
        expect(expired).toBe(true);

        const audit = await database.auditLog.findFirst({
          where: { action: "intake.information_request_expired", resourceId: createdCaseId },
          orderBy: { createdAt: "desc" },
        });
        expect(audit?.actorAccountId).toBe(staffAccountId);
        expect(audit?.changes).toMatchObject({
          manual_override: true,
          reason,
          request_id: publishedRequestId,
        });

        // Once expired (no longer "published"), the timer lookup no longer
        // returns it -- same ambiguous-null the operations service's 404/409
        // split has to disambiguate against getCaseForOperations.
        const afterExpiry = await intakeRepository.getPublishedInformationRequestForTimer(
          createdCaseId,
          publishedRequestId,
        );
        expect(afterExpiry).toBeNull();
      });
    });

    describe("expireInformationRequest without manualOverride (the batch job's own call shape)", () => {
      let secondRequestId = "";
      const secondTraceId = `trace_${suffix}_second`;

      it("sets up a second case with a published request to expire the batch-job way", async () => {
        const created = await intakeRepository.createStaffCase({
          applicantAccountId,
          staffAccountId,
          traceId: secondTraceId,
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
            rooms: [],
          },
          submissionData: { attestations: { staff_created: true } },
          documents: [
            { documentType: "ownership_declaration", documentRef: "doc-owner-2", extractDated: null },
            { documentType: "property_facts_sheet", documentRef: "doc-facts-2", extractDated: null },
            { documentType: "encumbrance_declaration", documentRef: "doc-enc-2", extractDated: null },
            { documentType: "photo_set", documentRef: "doc-photos-2", extractDated: null },
          ],
        });
        secondCaseId = created.caseId;

        const published = await intakeRepository.publishInformationRequest({
          accountId: staffAccountId,
          caseId: secondCaseId,
          traceId: secondTraceId,
          requestBody: "Second request, expired without a manual override.",
          publishedAt: new Date(),
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        secondRequestId = published?.requestId ?? "";
        expect(secondRequestId).not.toBe("");
      });

      it("records a null actor and no manual-override marker, matching the batch job's own shape", async () => {
        const expired = await intakeRepository.expireInformationRequest({
          requestId: secondRequestId,
          caseId: secondCaseId,
          traceId: secondTraceId,
          expiredAt: new Date(),
        });
        expect(expired).toBe(true);

        const audit = await database.auditLog.findFirst({
          where: { action: "intake.information_request_expired", resourceId: secondCaseId },
        });
        expect(audit?.actorAccountId).toBeNull();
        expect(audit?.changes).not.toHaveProperty("manual_override");
        expect(audit?.changes).not.toHaveProperty("reason");
      });
    });
  },
);
