import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "investor offering PostgreSQL integration",
  () => {
    const suffix = randomUUID();
    const accountId = `account_${suffix}`;
    const betterAuthUserId = `auth_${suffix}`;
    const propertyId = `property_${suffix}`;
    const caseId = `case_${suffix}`;
    const pivId = `piv_${suffix}`;
    const offeringId = `offering_${suffix}`;
    const disclosurePackId = `pack_${suffix}`;
    const reservationIds = {
      funded: `reservation_funded_${suffix}`,
      pending: `reservation_pending_${suffix}`,
      cancelled: `reservation_cancelled_${suffix}`,
    };
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    const repository = new PrismaOfferingRepository(database);

    beforeAll(async () => {
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [
          betterAuthUserId,
          "Offering Detail Investor",
          `offering-${suffix}@example.test`,
          true,
          "customer",
        ],
      );
      await database.account.create({
        data: {
          id: accountId,
          betterAuthUserId,
          loginMethods: {
            create: [
              {
                id: `login_email_${suffix}`,
                methodType: "email_password",
                providerSubject: `email_${suffix}`,
              },
              {
                id: `login_google_${suffix}`,
                methodType: "google",
                providerSubject: `google_${suffix}`,
              },
            ],
          },
          kycEligibility: {
            create: {
              eligibilityState: "eligible",
              renewalDueAt: new Date("2027-09-01T12:00:00.000Z"),
            },
          },
          walletRegistration: {
            create: {
              walletAddress: `0x${suffix.replaceAll("-", "")}`,
              registrationCommitment: `commitment_${suffix}`,
              registeredAt: new Date("2026-08-15T12:00:00.000Z"),
            },
          },
        },
      });
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "DE",
          city: "Berlin",
          addressLine: "Example Strasse 1",
          ownerDeclaredValueEur: "600000.00",
        },
      });
      await database.originationCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: accountId,
          stage: "approved_for_final_offering",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
          appraisalValueOpinionEur: "625000.00",
          ipoEndAt: new Date("2026-10-01T12:00:00.000Z"),
        },
      });
      await database.piv.create({
        data: {
          id: pivId,
          propertyId,
          caseId,
          legalName: "VistaBlox Berlin 01 B.V.",
          jurisdiction: "NL",
          registrationNo: `registration_${suffix}`,
          incorporatedAt: new Date("2026-08-01T12:00:00.000Z"),
        },
      });
      await database.offering.create({
        data: {
          id: offeringId,
          pivId,
          minimumRaiseEur: "250000.00",
          targetRaiseEur: "500000.00",
          status: "pre_offering",
          disclosurePacks: {
            create: {
              id: disclosurePackId,
              version: 2,
              publishedAt: new Date("2026-08-30T12:00:00.000Z"),
              documents: {
                create: [
                  {
                    id: `document_kiis_${suffix}`,
                    documentType: "ecsp_kiis",
                    documentRef: `offerings/${offeringId}/kiis-v2.pdf`,
                  },
                  {
                    id: `document_prospectus_${suffix}`,
                    documentType: "full_prospectus",
                    documentRef: `offerings/${offeringId}/prospectus-v2.pdf`,
                    isCoreReading: false,
                  },
                ],
              },
            },
          },
          materialityRecords: {
            create: {
              id: `materiality_${suffix}`,
              changeDescription: "Updated appraisal value",
              classification: "reviewed_material",
              resetTriggered: true,
            },
          },
        },
      });
      await database.reservation.createMany({
        data: [
          {
            id: reservationIds.funded,
            offeringId,
            accountId,
            amountEur: "100000.00",
            reservationStage: "initiated",
          },
          {
            id: reservationIds.pending,
            offeringId,
            accountId,
            amountEur: "25000.00",
            reservationStage: "initiated",
          },
          {
            id: reservationIds.cancelled,
            offeringId,
            accountId,
            amountEur: "9999.00",
            reservationStage: "cancelled",
          },
        ],
      });
      await database.moneyEvent.createMany({
        data: [
          {
            id: `money_funded_old_${suffix}`,
            reservationId: reservationIds.funded,
            provider: "stripe_onramp",
            capitalState: "eurc_purchase_pending",
            amountEur: "100000.00",
            recordedAt: new Date("2026-08-30T10:00:00.000Z"),
          },
          {
            id: `money_funded_latest_${suffix}`,
            reservationId: reservationIds.funded,
            provider: "internal",
            capitalState: "eurc_reserved",
            amountEur: "100000.00",
            recordedAt: new Date("2026-08-30T11:00:00.000Z"),
          },
          {
            id: `money_pending_${suffix}`,
            reservationId: reservationIds.pending,
            provider: "stripe_onramp",
            capitalState: "eurc_purchase_pending",
            amountEur: "25000.00",
          },
          {
            id: `money_cancelled_${suffix}`,
            reservationId: reservationIds.cancelled,
            provider: "internal",
            capitalState: "eurc_reserved",
            amountEur: "9999.00",
          },
        ],
      });
    });

    afterAll(async () => {
      await database.moneyEvent.deleteMany({
        where: { reservationId: { in: Object.values(reservationIds) } },
      });
      await database.reservation.deleteMany({ where: { offeringId } });
      await database.materialityRecord.deleteMany({ where: { offeringId } });
      await database.disclosureDocument.deleteMany({
        where: { disclosurePackId },
      });
      await database.disclosurePack.deleteMany({ where: { offeringId } });
      await database.offering.deleteMany({ where: { id: offeringId } });
      await database.piv.deleteMany({ where: { id: pivId } });
      await database.originationCase.deleteMany({ where: { id: caseId } });
      await database.property.deleteMany({ where: { id: propertyId } });
      await database.walletRegistration.deleteMany({ where: { accountId } });
      await database.kycEligibility.deleteMany({ where: { accountId } });
      await database.loginMethod.deleteMany({ where: { accountId } });
      await database.account.deleteMany({ where: { id: accountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [
        betterAuthUserId,
      ]);
      await Promise.all([database.$disconnect(), authPool.end()]);
    });

    it("returns full disclosure, readiness inputs, and canonical raise progress", async () => {
      const result = await repository.getInvestorDetail({
        offeringId,
        accountId,
      });

      expect(result).toMatchObject({
        id: offeringId,
        minimumRaiseEur: "250000.00",
        targetRaiseEur: "500000.00",
        reservedCapacityEur: "125000.00",
        fundedEur: "100000.00",
        issuer: {
          pivId,
          legalName: "VistaBlox Berlin 01 B.V.",
          jurisdiction: "NL",
        },
        property: {
          propertyId,
          countryCode: "DE",
          city: "Berlin",
          appraisalValueOpinionEur: "625000.00",
        },
        currentDisclosurePack: {
          id: disclosurePackId,
          version: 2,
          documents: [
            { documentType: "ecsp_kiis", isCoreReading: true },
            { documentType: "full_prospectus", isCoreReading: false },
          ],
        },
        materialityRecords: [
          {
            changeDescription: "Updated appraisal value",
            resetTriggered: true,
          },
        ],
        accountReadiness: {
          status: "active",
          loginMethods: expect.arrayContaining(["google", "email_password"]),
          kycEligibilityState: "eligible",
          walletProvisioned: true,
          payoutWalletRegistered: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain("walletAddress");
      expect(JSON.stringify(result)).not.toContain("providerReference");
    });
  },
);
