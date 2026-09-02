import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import { disclosureDocumentTypes } from "../src/modules/offering/domain/disclosure-pack.policy.js";
import { NotifyReconfirmationWindowOpenedService } from "../src/modules/offering/application/notify-reconfirmation-window-opened.service.js";
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
    const historicalDisclosurePackId = `pack_historical_${suffix}`;
    const currentDocumentId = `document_kiis_${suffix}`;
    const historicalDocumentId = `document_historical_${suffix}`;
    const reservationIds = {
      funded: `reservation_funded_${suffix}`,
      pending: `reservation_pending_${suffix}`,
      cancelled: `reservation_cancelled_${suffix}`,
    };
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // PgBoss's constructor eagerly validates its connection string (unlike
    // PrismaClient/pg.Pool above, which connect lazily), so it must not be
    // constructed at describe-body scope: that body runs even when skipIf
    // skips every test, and databaseUrl is undefined in that case.
    let boss: PgBoss;
    let repository: PrismaOfferingRepository;

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      repository = new PrismaOfferingRepository(database, boss);
      await boss.start();
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
                    id: currentDocumentId,
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
      await database.disclosurePack.create({
        data: {
          id: historicalDisclosurePackId,
          offeringId,
          version: 1,
          publishedAt: new Date("2026-08-20T12:00:00.000Z"),
          supersededAt: new Date("2026-08-30T12:00:00.000Z"),
          isCurrent: false,
          documents: {
            create: {
              id: historicalDocumentId,
              documentType: "final_terms_sheet",
              documentRef: `offerings/${offeringId}/terms-v1.pdf`,
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
            disclosurePackVersionAtReservation: "1",
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
        where: {
          disclosurePackId: {
            in: [disclosurePackId, historicalDisclosurePackId],
          },
        },
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
      await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
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

    it("authorizes current documents generally and historical versions only through a reservation", async () => {
      await expect(
        repository.getAccessibleDocument({
          accountId: `unrelated_${suffix}`,
          offeringId,
          documentId: currentDocumentId,
        }),
      ).resolves.toMatchObject({
        documentReference: `offerings/${offeringId}/kiis-v2.pdf`,
        disclosurePackVersion: 2,
      });

      await expect(
        repository.getAccessibleDocument({
          accountId,
          offeringId,
          documentId: historicalDocumentId,
        }),
      ).resolves.toMatchObject({
        documentReference: `offerings/${offeringId}/terms-v1.pdf`,
        disclosurePackVersion: 1,
      });

      await expect(
        repository.getAccessibleDocument({
          accountId: `unrelated_${suffix}`,
          offeringId,
          documentId: historicalDocumentId,
        }),
      ).resolves.toBeNull();

      await expect(
        repository.getAccessibleDocument({
          accountId,
          offeringId: `wrong_${suffix}`,
          documentId: currentDocumentId,
        }),
      ).resolves.toBeNull();
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "reservation creation PostgreSQL integration (AD-146)",
  () => {
    const suffix = randomUUID();
    const accountId = `account_reserve_${suffix}`;
    const betterAuthUserId = `auth_reserve_${suffix}`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // PgBoss's constructor eagerly validates its connection string, so it
    // must not be constructed at describe-body scope (see the previous
    // describe block's comment for why).
    let boss: PgBoss;
    let repository: PrismaOfferingRepository;
    const offeringIds: string[] = [];
    const pivIds: string[] = [];
    const caseIds: string[] = [];
    const propertyIds: string[] = [];

    async function createOffering(input: {
      targetRaiseEur: string;
      status?: string;
    }): Promise<string> {
      const id = randomUUID();
      const propertyId = `property_reserve_${id}`;
      const caseId = `case_reserve_${id}`;
      const pivId = `piv_reserve_${id}`;
      const offeringId = `offering_reserve_${id}`;
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "DE",
          city: "Leipzig",
          addressLine: "Reservation Test 1",
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
        },
      });
      await database.piv.create({
        data: { id: pivId, propertyId, caseId },
      });
      await database.offering.create({
        data: {
          id: offeringId,
          pivId,
          minimumRaiseEur: input.targetRaiseEur,
          targetRaiseEur: input.targetRaiseEur,
          status: input.status ?? "pre_offering",
        },
      });
      propertyIds.push(propertyId);
      caseIds.push(caseId);
      pivIds.push(pivId);
      offeringIds.push(offeringId);
      return offeringId;
    }

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      repository = new PrismaOfferingRepository(database, boss);
      await boss.start();
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserId, "Reservation Creation Investor", `reserve-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId } });
    });

    afterAll(async () => {
      await database.moneyEvent.deleteMany({ where: { reservation: { offeringId: { in: offeringIds } } } });
      await database.auditLog.deleteMany({ where: { resourceType: "reservation" } });
      await database.reservation.deleteMany({ where: { offeringId: { in: offeringIds } } });
      await database.offering.deleteMany({ where: { id: { in: offeringIds } } });
      await database.piv.deleteMany({ where: { id: { in: pivIds } } });
      await database.originationCase.deleteMany({ where: { id: { in: caseIds } } });
      await database.property.deleteMany({ where: { id: { in: propertyIds } } });
      await database.account.deleteMany({ where: { id: accountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
      await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
    });

    it("creates a reservation, a matching money event, and an audit trail", async () => {
      const offeringId = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;

      const result = await repository.createReservation({
        reservationId,
        offeringId,
        accountId,
        amountEur: "400.00",
        disclosurePackVersionAtReservation: "1",
        traceId: `trace_${suffix}`,
        createdAt: new Date("2026-09-02T10:00:00.000Z"),
      });

      expect(result).toEqual({
        conflict: null,
        reservation: { reservationId, createdAt: new Date("2026-09-02T10:00:00.000Z") },
      });
      const reservation = await database.reservation.findUnique({ where: { id: reservationId } });
      expect(reservation).toMatchObject({ offeringId, accountId, reservationStage: "initiated" });
      expect(reservation?.amountEur.toFixed(2)).toBe("400.00");
      const moneyEvents = await database.moneyEvent.findMany({ where: { reservationId } });
      expect(moneyEvents).toMatchObject([{ provider: "coinbase_cdp", capitalState: "initiated" }]);
      expect(
        await database.auditLog.count({
          where: { resourceId: reservationId, action: "offering.reservation_created" },
        }),
      ).toBe(1);
    });

    it("rejects an amount that would exceed remaining capacity without writing a row", async () => {
      const offeringId = await createOffering({ targetRaiseEur: "1000.00" });
      await repository.createReservation({
        reservationId: `reservation_${randomUUID()}`,
        offeringId,
        accountId,
        amountEur: "400.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });

      const rejectedId = `reservation_${randomUUID()}`;
      const result = await repository.createReservation({
        reservationId: rejectedId,
        offeringId,
        accountId,
        amountEur: "700.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });

      expect(result).toEqual({ conflict: "capacity_exceeded", reservation: null });
      expect(await database.reservation.findUnique({ where: { id: rejectedId } })).toBeNull();
    });

    it("rejects a reservation on an offering that is not pre_offering", async () => {
      const offeringId = await createOffering({ targetRaiseEur: "1000.00", status: "final_offering" });

      const result = await repository.createReservation({
        reservationId: `reservation_${randomUUID()}`,
        offeringId,
        accountId,
        amountEur: "1.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });

      expect(result).toEqual({ conflict: "offering_not_open", reservation: null });
    });

    it("serializes concurrent reservations so combined capacity is never oversold (AD-146)", async () => {
      const offeringId = await createOffering({ targetRaiseEur: "1000.00" });

      const [first, second] = await Promise.all([
        repository.createReservation({
          reservationId: `reservation_${randomUUID()}`,
          offeringId,
          accountId,
          amountEur: "600.00",
          disclosurePackVersionAtReservation: null,
          traceId: `trace_${suffix}`,
          createdAt: new Date(),
        }),
        repository.createReservation({
          reservationId: `reservation_${randomUUID()}`,
          offeringId,
          accountId,
          amountEur: "600.00",
          disclosurePackVersionAtReservation: null,
          traceId: `trace_${suffix}`,
          createdAt: new Date(),
        }),
      ]);

      const outcomes = [first, second];
      expect(outcomes.filter((outcome) => outcome.conflict === null)).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.conflict === "capacity_exceeded")).toHaveLength(1);
      const reservedRows = await database.reservation.aggregate({
        where: { offeringId, reservationStage: { notIn: ["cancelled", "lapsed"] } },
        _sum: { amountEur: true },
      });
      expect(reservedRows._sum.amountEur?.toFixed(2)).toBe("600.00");
    });

    it("lists only initiated reservations for the expiry timer, and expiring one is idempotent", async () => {
      const offeringId = await createOffering({ targetRaiseEur: "1000.00" });
      const initiatedId = `reservation_${randomUUID()}`;
      const cancelledId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId: initiatedId,
        offeringId,
        accountId,
        amountEur: "100.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date("2026-09-02T09:00:00.000Z"),
      });
      await database.reservation.create({
        data: {
          id: cancelledId,
          offeringId,
          accountId,
          amountEur: "50.00",
          reservationStage: "cancelled",
        },
      });

      const forTimers = await repository.listInitiatedReservationsForTimers();
      expect(forTimers.map((r) => r.reservationId)).toContain(initiatedId);
      expect(forTimers.map((r) => r.reservationId)).not.toContain(cancelledId);

      const expiredAt = new Date("2026-09-02T09:20:00.000Z");
      const firstAttempt = await repository.expireReservation({
        reservationId: initiatedId,
        traceId: `trace_${suffix}`,
        expiredAt,
      });
      expect(firstAttempt).toBe(true);
      const lapsed = await database.reservation.findUnique({ where: { id: initiatedId } });
      expect(lapsed?.reservationStage).toBe("lapsed");
      expect(
        await database.auditLog.count({
          where: { resourceId: initiatedId, action: "offering.reservation_lapsed" },
        }),
      ).toBe(1);

      const secondAttempt = await repository.expireReservation({
        reservationId: initiatedId,
        traceId: `trace_${suffix}`,
        expiredAt,
      });
      expect(secondAttempt).toBe(false);
      expect(
        await database.auditLog.count({
          where: { resourceId: initiatedId, action: "offering.reservation_lapsed" },
        }),
      ).toBe(1);

      const capacityAfterExpiry = await database.reservation.aggregate({
        where: { offeringId, reservationStage: { notIn: ["cancelled", "lapsed"] } },
        _sum: { amountEur: true },
      });
      expect(capacityAfterExpiry._sum.amountEur).toBeNull();
    });

    it("reports the latest capital state per reservation and finds only eurc_purchase_pending ones for the onramp poll", async () => {
      const offeringId = await createOffering({ targetRaiseEur: "1000.00" });
      const fundedId = `reservation_${randomUUID()}`;
      const pendingId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId: fundedId,
        offeringId,
        accountId,
        amountEur: "200.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.createReservation({
        reservationId: pendingId,
        offeringId,
        accountId,
        amountEur: "300.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId: fundedId,
        provider: "coinbase_cdp",
        providerReference: "channel_01",
        capitalState: "eurc_purchase_pending",
        amountEur: "200.00",
        amountEurc: null,
        recordedAt: new Date("2026-09-02T09:00:00.000Z"),
      });
      await repository.recordMoneyEvent({
        reservationId: fundedId,
        provider: "coinbase_cdp",
        providerReference: "txn_01",
        capitalState: "eurc_reserved",
        amountEur: "200.00",
        amountEurc: "190.000000",
        recordedAt: new Date("2026-09-02T09:05:00.000Z"),
      });
      await repository.recordMoneyEvent({
        reservationId: pendingId,
        provider: "coinbase_cdp",
        providerReference: "channel_02",
        capitalState: "eurc_purchase_pending",
        amountEur: "300.00",
        amountEurc: null,
        recordedAt: new Date("2026-09-02T09:00:00.000Z"),
      });

      const forTimers = await repository.listInitiatedReservationsForTimers();
      expect(forTimers.find((r) => r.reservationId === fundedId)?.latestCapitalState).toBe("eurc_reserved");
      expect(forTimers.find((r) => r.reservationId === pendingId)?.latestCapitalState).toBe(
        "eurc_purchase_pending",
      );

      const pendingPurchases = await repository.listPendingPurchaseReservationsForTimers();
      const pendingIds = pendingPurchases.map((r) => r.reservationId);
      expect(pendingIds).toContain(pendingId);
      expect(pendingIds).not.toContain(fundedId);
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "offering finalization PostgreSQL integration (AD-244/AD-245/AD-214)",
  () => {
    const suffix = randomUUID();
    const fundedAccountId = `account_finalize_funded_${suffix}`;
    const unfundedAccountId = `account_finalize_unfunded_${suffix}`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // PgBoss's constructor eagerly validates its connection string, so it
    // must not be constructed at describe-body scope (see the first
    // describe block's comment for why).
    let boss: PgBoss;
    let repository: PrismaOfferingRepository;
    const offeringIds: string[] = [];
    const pivIds: string[] = [];
    const caseIds: string[] = [];
    const propertyIds: string[] = [];

    async function createOffering(input: { targetRaiseEur: string; status?: string }): Promise<{
      offeringId: string;
      pivId: string;
    }> {
      const id = randomUUID();
      const propertyId = `property_finalize_${id}`;
      const caseId = `case_finalize_${id}`;
      const pivId = `piv_finalize_${id}`;
      const offeringId = `offering_finalize_${id}`;
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "DE",
          city: "Munich",
          addressLine: "Finalization Test 1",
          ownerDeclaredValueEur: "600000.00",
        },
      });
      await database.originationCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: fundedAccountId,
          stage: "approved_for_final_offering",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
        },
      });
      await database.piv.create({ data: { id: pivId, propertyId, caseId } });
      await database.offering.create({
        data: {
          id: offeringId,
          pivId,
          minimumRaiseEur: input.targetRaiseEur,
          targetRaiseEur: input.targetRaiseEur,
          status: input.status ?? "pre_offering",
        },
      });
      propertyIds.push(propertyId);
      caseIds.push(caseId);
      pivIds.push(pivId);
      offeringIds.push(offeringId);
      return { offeringId, pivId };
    }

    // reconfirmReservation requires a complete current pack (AD-037) —
    // every mandatory document type, matching disclosureDocumentTypes.
    async function publishCompleteDisclosurePack(offeringId: string, publishedAt: Date): Promise<void> {
      const result = await repository.publishDisclosurePack({
        offeringId,
        accountId: "account_founder",
        documents: disclosureDocumentTypes.map((documentType) => ({
          documentType,
          documentRef: `documents/${documentType}.pdf`,
        })),
        traceId: `trace_${suffix}`,
        publishedAt,
      });
      if (result.conflict !== null) {
        throw new Error(`expected publishDisclosurePack to succeed, got conflict: ${result.conflict}`);
      }
    }

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      repository = new PrismaOfferingRepository(database, boss);
      await boss.start();
      // publishFinalOfferingTerms enqueues the AD-214/AD-145 window-opened
      // notification handoff inside its own transaction — the queue must
      // already exist or that send() fails against a queue that doesn't.
      await boss.createQueue("case_timers.offering_reconfirmation_window_opened");
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)',
        [
          `auth_${fundedAccountId}`,
          "Funded Investor",
          `finalize-funded-${suffix}@example.test`,
          true,
          "customer",
          `auth_${unfundedAccountId}`,
          "Unfunded Investor",
          `finalize-unfunded-${suffix}@example.test`,
          true,
          "customer",
        ],
      );
      await database.account.create({
        data: {
          id: fundedAccountId,
          betterAuthUserId: `auth_${fundedAccountId}`,
          walletRegistration: {
            create: {
              walletAddress: `0x${suffix.replaceAll("-", "")}f`,
              registrationCommitment: `commitment_${suffix}`,
              registeredAt: new Date("2026-08-15T12:00:00.000Z"),
            },
          },
        },
      });
      await database.account.create({
        data: { id: unfundedAccountId, betterAuthUserId: `auth_${unfundedAccountId}` },
      });
    });

    afterAll(async () => {
      await database.positionLedger.deleteMany({ where: { pivId: { in: pivIds } } });
      await database.materialityRecord.deleteMany({ where: { offeringId: { in: offeringIds } } });
      await database.disclosureDocument.deleteMany({
        where: { disclosurePack: { offeringId: { in: offeringIds } } },
      });
      await database.disclosurePack.deleteMany({ where: { offeringId: { in: offeringIds } } });
      await database.moneyEvent.deleteMany({ where: { reservation: { offeringId: { in: offeringIds } } } });
      await database.auditLog.deleteMany({ where: { resourceId: { in: offeringIds }, resourceType: "offering" } });
      await database.reservation.deleteMany({ where: { offeringId: { in: offeringIds } } });
      await database.offering.deleteMany({ where: { id: { in: offeringIds } } });
      await database.piv.deleteMany({ where: { id: { in: pivIds } } });
      await database.originationCase.deleteMany({ where: { id: { in: caseIds } } });
      await database.property.deleteMany({ where: { id: { in: propertyIds } } });
      await database.walletRegistration.deleteMany({ where: { accountId: fundedAccountId } });
      await database.account.deleteMany({ where: { id: { in: [fundedAccountId, unfundedAccountId] } } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = ANY($1)', [
        [`auth_${fundedAccountId}`, `auth_${unfundedAccountId}`],
      ]);
      await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
    });

    it("publishes final terms, moving the funded reservation to awaiting_reconfirmation and cancelling the unfunded one, without creating a position yet", async () => {
      const { offeringId, pivId } = await createOffering({ targetRaiseEur: "1000.00" });
      const fundedReservationId = `reservation_${randomUUID()}`;
      const unfundedReservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId: fundedReservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "700.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId: fundedReservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_01",
        capitalState: "eurc_reserved",
        amountEur: "700.00",
        amountEurc: "690.000000",
        recordedAt: new Date(),
      });
      await repository.createReservation({
        reservationId: unfundedReservationId,
        offeringId,
        accountId: unfundedAccountId,
        amountEur: "300.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });

      const publishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt);
      const result = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "Target reached, proceeding to tokenization.",
        traceId: `trace_${suffix}`,
        publishedAt,
      });

      expect(result).toEqual({
        conflict: null,
        published: {
          offeringId,
          finalOfferingPublishedAt: publishedAt,
          platformRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
          effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
          reservationsAwaitingReconfirmation: 1,
          reservationsCancelled: 1,
        },
      });

      // offerings.status stays pre_offering through the whole reconfirmation
      // window — it only becomes final_offering once commitOfferingFinalization
      // runs (CORE_TABLES.md).
      const offering = await database.offering.findUnique({ where: { id: offeringId } });
      expect(offering).toMatchObject({ status: "pre_offering" });
      expect(offering?.finalOfferingPublishedAt).toEqual(publishedAt);
      expect(offering?.effectiveRightsEndAt).toEqual(new Date("2026-09-09T12:00:00.000Z"));

      const fundedReservation = await database.reservation.findUnique({ where: { id: fundedReservationId } });
      expect(fundedReservation).toMatchObject({ reservationStage: "awaiting_reconfirmation" });
      const unfundedReservation = await database.reservation.findUnique({ where: { id: unfundedReservationId } });
      expect(unfundedReservation).toMatchObject({ reservationStage: "cancelled" });

      expect(await database.positionLedger.count({ where: { pivId } })).toBe(0);
      expect(
        await database.auditLog.count({
          where: { resourceId: offeringId, action: "offering.final_terms_published" },
        }),
      ).toBe(1);
    });

    it("durably enqueues the reconfirmation-window-opened notification job, and processing it is replay-safe", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_window_opened_01",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      const publishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt);
      const traceId = `trace_window_opened_${suffix}`;
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId,
        publishedAt,
      });

      // AD-145: the handoff must be durably queued in the same transaction
      // as the state change, not sent synchronously — assert the row exists
      // in pgboss.job directly, the same technique
      // origination-offering-handoff.integration.test.ts already uses for
      // case_timers.pre_offering_open_handoff.
      const enqueued = await authPool.query<{
        name: string;
        data: { offering_id: string; reservation_ids: string[]; trace_id: string };
      }>("SELECT name, data FROM pgboss.job WHERE name = $1 AND data->>'offering_id' = $2", [
        "case_timers.offering_reconfirmation_window_opened",
        offeringId,
      ]);
      expect(enqueued.rows).toHaveLength(1);
      expect(enqueued.rows[0]?.data).toEqual({
        offering_id: offeringId,
        reservation_ids: [reservationId],
        trace_id: traceId,
      });

      // fundedAccountId's own fixture never sets protectedContactEmail, so
      // whether the service actually emails depends on live DB state rather
      // than something safe to hard-code here — read it back rather than
      // assuming, the same approach the reconfirmation-reminder integration
      // test above already takes for the same shared fixture account.
      const account = await database.account.findUnique({ where: { id: fundedAccountId } });
      const expectedActed = account?.protectedContactEmail == null ? 0 : 1;
      const email: EmailSender = {
        sendVerificationEmail: vi.fn(),
        sendPasswordResetEmail: vi.fn(),
        sendStaffInvitationEmail: vi.fn(),
        sendApplicantResponseReminderEmail: vi.fn(),
        sendKycRenewalReminderEmail: vi.fn(),
        sendReconfirmationReminderEmail: vi.fn(),
        sendReconfirmationWindowOpenedEmail: vi.fn().mockResolvedValue(undefined),
      };
      const notifyService = new NotifyReconfirmationWindowOpenedService(repository, email);

      const summary = await notifyService.execute(enqueued.rows[0]?.data);
      expect(summary).toEqual({ checked: 1, acted: expectedActed });
      expect(
        await database.auditLog.count({
          where: {
            resourceId: reservationId,
            resourceType: "reservation",
            action: "offering.reconfirmation_window_opened_notification_sent",
          },
        }),
      ).toBe(expectedActed);

      // Replaying the same job payload (as pg-boss would on a retry) must
      // not double-email the investor or create a second audit row — the
      // same replay-safety origination's own handoff test already checks.
      const replayed = await notifyService.execute(enqueued.rows[0]?.data);
      expect(replayed).toEqual({ checked: 1, acted: 0 });
      expect(
        await database.auditLog.count({
          where: {
            resourceId: reservationId,
            resourceType: "reservation",
            action: "offering.reconfirmation_window_opened_notification_sent",
          },
        }),
      ).toBe(expectedActed);
    });

    it("reports offering_not_found for an unknown offering", async () => {
      const result = await repository.publishFinalOfferingTerms({
        offeringId: `offering_missing_${suffix}`,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: new Date(),
      });

      expect(result).toEqual({ published: null, conflict: "offering_not_found" });
    });

    it("reports not_open for an offering that already left pre_offering", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00", status: "final_offering" });

      const result = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: new Date(),
      });

      expect(result).toEqual({ published: null, conflict: "not_open" });
    });

    it("reports already_published once final terms have already been published", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_already_published",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      const alreadyPublishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, alreadyPublishedAt);
      const first = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: alreadyPublishedAt,
      });
      expect(first.conflict).toBeNull();

      const second = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: new Date("2026-09-02T13:00:00.000Z"),
      });

      expect(second).toEqual({ published: null, conflict: "already_published" });
    });

    it("reports target_not_reached when funded_eur falls short, however small the gap", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "999.99",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_02",
        capitalState: "eurc_reserved",
        amountEur: "999.99",
        amountEurc: null,
        recordedAt: new Date(),
      });

      const result = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: new Date(),
      });

      expect(result).toEqual({ published: null, conflict: "target_not_reached" });
    });

    it("reconfirms a reservation that is awaiting reconfirmation", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_reconfirm_01",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      const publishedAt01 = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt01);
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: publishedAt01,
      });

      const reconfirmedAt = new Date("2026-09-03T12:00:00.000Z");
      const result = await repository.reconfirmReservation({
        reservationId,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt,
      });

      expect(result).toEqual({ reconfirmedAt, conflict: null });
      const reservation = await database.reservation.findUnique({ where: { id: reservationId } });
      expect(reservation).toMatchObject({ reservationStage: "reconfirmed" });
      expect(reservation?.reconfirmedAt).toEqual(reconfirmedAt);
      expect(
        await database.auditLog.count({
          where: { resourceId: reservationId, action: "offering.reservation_reconfirmed" },
        }),
      ).toBe(1);
    });

    it("reports not_found for a nonexistent reservation or one owned by someone else", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_reconfirm_02",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: new Date("2026-09-02T12:00:00.000Z"),
      });

      const wrongOwner = await repository.reconfirmReservation({
        reservationId,
        accountId: unfundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      });
      expect(wrongOwner).toEqual({ reconfirmedAt: null, conflict: "not_found" });

      const missing = await repository.reconfirmReservation({
        reservationId: `reservation_missing_${suffix}`,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      });
      expect(missing).toEqual({ reconfirmedAt: null, conflict: "not_found" });
    });

    it("reports not_awaiting_reconfirmation for a reservation that has not been published yet", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });

      const result = await repository.reconfirmReservation({
        reservationId,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date(),
      });

      expect(result).toEqual({ reconfirmedAt: null, conflict: "not_awaiting_reconfirmation" });
    });

    it("reports window_closed once the reconfirmation window has passed", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_reconfirm_03",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      const windowClosedPublishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, windowClosedPublishedAt);
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: windowClosedPublishedAt,
      });

      const result = await repository.reconfirmReservation({
        reservationId,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-09T12:00:00.001Z"),
      });

      expect(result).toEqual({ reconfirmedAt: null, conflict: "window_closed" });
    });

    it("publishFinalOfferingTerms reports disclosure_pack_incomplete when no disclosure pack has been published yet", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_publish_pack_01",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });

      const result = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: new Date("2026-09-02T12:00:00.000Z"),
      });

      expect(result).toEqual({ published: null, conflict: "disclosure_pack_incomplete" });
      const offering = await database.offering.findUnique({ where: { id: offeringId } });
      expect(offering?.finalOfferingPublishedAt).toBeNull();
      const reservation = await database.reservation.findUnique({ where: { id: reservationId } });
      expect(reservation).toMatchObject({ reservationStage: "initiated" });
    });

    it("publishFinalOfferingTerms reports disclosure_pack_incomplete when the current pack is missing a mandatory document type", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_publish_pack_02",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      // Every mandatory type except full_prospectus — deliberately incomplete.
      const partialTypes = disclosureDocumentTypes.filter((type) => type !== "full_prospectus");
      const publishedPack = await repository.publishDisclosurePack({
        offeringId,
        accountId: "account_founder",
        documents: partialTypes.map((documentType) => ({
          documentType,
          documentRef: `documents/${documentType}.pdf`,
        })),
        traceId: `trace_${suffix}`,
        publishedAt: new Date("2026-09-01T09:00:00.000Z"),
      });
      expect(publishedPack.published?.isComplete).toBe(false);

      const result = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: new Date("2026-09-02T12:00:00.000Z"),
      });

      expect(result).toEqual({ published: null, conflict: "disclosure_pack_incomplete" });
    });

    it("reconfirmReservation reports disclosure_pack_incomplete when the current pack is republished incomplete after final terms were already published", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_reconfirm_pack_01",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      const publishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt);
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt,
      });

      // The only reachable way the current pack can be incomplete once
      // publishFinalOfferingTerms itself already requires completeness: a
      // later republish (e.g. materiality-triggered) that lands incomplete.
      const partialTypes = disclosureDocumentTypes.filter((type) => type !== "full_prospectus");
      const republishedPack = await repository.publishDisclosurePack({
        offeringId,
        accountId: "account_founder",
        documents: partialTypes.map((documentType) => ({
          documentType,
          documentRef: `documents/${documentType}-v2.pdf`,
        })),
        traceId: `trace_${suffix}`,
        publishedAt: new Date("2026-09-03T00:00:00.000Z"),
      });
      expect(republishedPack.published?.isComplete).toBe(false);

      const result = await repository.reconfirmReservation({
        reservationId,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      });

      expect(result).toEqual({ reconfirmedAt: null, conflict: "disclosure_pack_incomplete" });
    });

    it("reports commitOfferingFinalization's offering_not_found for an unknown offering", async () => {
      const result = await repository.commitOfferingFinalization({
        offeringId: `offering_missing_${suffix}`,
        traceId: `trace_${suffix}`,
        finalizedAt: new Date(),
      });

      expect(result).toEqual({ committed: null, conflict: "offering_not_found" });
    });

    it("reports not_publishable_state before final terms have been published", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });

      const result = await repository.commitOfferingFinalization({
        offeringId,
        traceId: `trace_${suffix}`,
        finalizedAt: new Date(),
      });

      expect(result).toEqual({ committed: null, conflict: "not_publishable_state" });
    });

    it("commits only reconfirmed reservations into positions, lapses the rest, and publishes the offering once the window closes", async () => {
      const { offeringId, pivId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reconfirmedReservationId = `reservation_${randomUUID()}`;
      const lapsedReservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId: reconfirmedReservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "700.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId: reconfirmedReservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_commit_01",
        capitalState: "eurc_reserved",
        amountEur: "700.00",
        amountEurc: "690.000000",
        recordedAt: new Date(),
      });
      await repository.createReservation({
        reservationId: lapsedReservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "300.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId: lapsedReservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_commit_02",
        capitalState: "eurc_reserved",
        amountEur: "300.00",
        amountEurc: null,
        recordedAt: new Date(),
      });

      const publishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt);
      const published = await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt,
      });
      expect(published.published?.reservationsAwaitingReconfirmation).toBe(2);

      const reconfirmResult = await repository.reconfirmReservation({
        reservationId: reconfirmedReservationId,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      });
      expect(reconfirmResult.conflict).toBeNull();

      // The window is 168 hours after publishedAt, i.e. 2026-09-09T12:00:00.000Z.
      const pending = await repository.listOfferingsPendingFinalizationCommit();
      expect(pending).toContainEqual({ offeringId, effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z") });

      const tooEarly = await repository.commitOfferingFinalization({
        offeringId,
        traceId: `trace_${suffix}`,
        finalizedAt: new Date("2026-09-09T11:00:00.000Z"),
      });
      expect(tooEarly).toEqual({ committed: null, conflict: "window_still_open" });

      const finalizedAt = new Date("2026-09-09T12:00:00.000Z");
      const committed = await repository.commitOfferingFinalization({
        offeringId,
        traceId: `trace_${suffix}`,
        finalizedAt,
      });

      expect(committed).toEqual({
        conflict: null,
        committed: { offeringId, positionsCreated: 1, reservationsLapsed: 1 },
      });

      const offering = await database.offering.findUnique({ where: { id: offeringId } });
      expect(offering).toMatchObject({ status: "final_offering" });

      const reconfirmedReservation = await database.reservation.findUnique({
        where: { id: reconfirmedReservationId },
      });
      expect(reconfirmedReservation).toMatchObject({ reservationStage: "finalized" });
      const lapsedReservation = await database.reservation.findUnique({ where: { id: lapsedReservationId } });
      expect(lapsedReservation).toMatchObject({ reservationStage: "lapsed" });

      const positions = await database.positionLedger.findMany({ where: { pivId } });
      expect(positions).toHaveLength(1);
      expect(positions[0]).toMatchObject({
        reservationId: reconfirmedReservationId,
        accountId: fundedAccountId,
        pivId,
        positionStatus: "pending_internal_settlement",
        holderWalletAddress: `0x${suffix.replaceAll("-", "")}f`,
      });
      expect(positions[0]?.unitCount.toFixed(6)).toBe("700.000000");
      expect(positions[0]?.costBasisEur.toFixed(2)).toBe("700.00");

      expect(
        await database.auditLog.count({ where: { resourceId: offeringId, action: "offering.finalized" } }),
      ).toBe(1);
    });

    it("records a per_se_material classification, resets already-reconfirmed reservations, and restarts the full 168-hour window", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reconfirmedReservationId = `reservation_${randomUUID()}`;
      const awaitingReservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId: reconfirmedReservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "700.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId: reconfirmedReservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_materiality_01",
        capitalState: "eurc_reserved",
        amountEur: "700.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      await repository.createReservation({
        reservationId: awaitingReservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "300.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId: awaitingReservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_materiality_02",
        capitalState: "eurc_reserved",
        amountEur: "300.00",
        amountEurc: null,
        recordedAt: new Date(),
      });

      const materialityPublishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, materialityPublishedAt);
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt: materialityPublishedAt,
      });
      const reconfirmResult = await repository.reconfirmReservation({
        reservationId: reconfirmedReservationId,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      });
      expect(reconfirmResult.conflict).toBeNull();

      const classifiedAt = new Date("2026-09-04T00:00:00.000Z");
      const result = await repository.classifyMateriality({
        offeringId,
        accountId: "account_founder",
        changeDescription: "Change of primary obligor.",
        classification: "per_se_material",
        thresholdType: null,
        traceId: `trace_${suffix}`,
        classifiedAt,
      });

      expect(result.conflict).toBeNull();
      expect(result.classified).toMatchObject({
        offeringId,
        classification: "per_se_material",
        thresholdType: null,
        resetTriggered: true,
        reservationsReset: 1,
      });
      // A fresh 168 hours from classifiedAt, not the original window extended.
      expect(result.classified?.effectiveRightsEndAt).toEqual(new Date("2026-09-11T00:00:00.000Z"));

      const reconfirmedReservation = await database.reservation.findUnique({
        where: { id: reconfirmedReservationId },
      });
      expect(reconfirmedReservation).toMatchObject({ reservationStage: "awaiting_reconfirmation" });
      expect(reconfirmedReservation?.reconfirmedAt).toBeNull();

      // Never-reconfirmed reservation has nothing to invalidate — untouched.
      const untouchedReservation = await database.reservation.findUnique({ where: { id: awaitingReservationId } });
      expect(untouchedReservation).toMatchObject({ reservationStage: "awaiting_reconfirmation" });

      const offering = await database.offering.findUnique({ where: { id: offeringId } });
      expect(offering?.effectiveRightsEndAt).toEqual(new Date("2026-09-11T00:00:00.000Z"));
      expect(offering?.platformRightsEndAt).toEqual(new Date("2026-09-11T00:00:00.000Z"));
      expect(offering).toMatchObject({ status: "pre_offering" });

      if (result.classified === null) throw new Error("expected a classified materiality record");
      const record = await database.materialityRecord.findUnique({
        where: { id: result.classified.materialityRecordId },
      });
      expect(record).toMatchObject({
        offeringId,
        changeDescription: "Change of primary obligor.",
        classification: "per_se_material",
        thresholdType: null,
        resetTriggered: true,
        classifiedByAccountId: "account_founder",
      });

      expect(
        await database.auditLog.count({
          where: { resourceId: offeringId, action: "offering.materiality_classified" },
        }),
      ).toBe(1);
    });

    it("records a non_material classification without resetting anything", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_materiality_03",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      const publishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt);
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt,
      });
      await repository.reconfirmReservation({
        reservationId,
        accountId: fundedAccountId,
        traceId: `trace_${suffix}`,
        reconfirmedAt: new Date("2026-09-03T12:00:00.000Z"),
      });

      const result = await repository.classifyMateriality({
        offeringId,
        accountId: "account_founder",
        changeDescription: "Corrected a typo in the property summary.",
        classification: "non_material",
        thresholdType: null,
        traceId: `trace_${suffix}`,
        classifiedAt: new Date("2026-09-04T00:00:00.000Z"),
      });

      expect(result.conflict).toBeNull();
      expect(result.classified).toMatchObject({ resetTriggered: false, reservationsReset: 0 });
      expect(result.classified?.effectiveRightsEndAt).toEqual(new Date("2026-09-09T12:00:00.000Z"));

      const reservation = await database.reservation.findUnique({ where: { id: reservationId } });
      expect(reservation).toMatchObject({ reservationStage: "reconfirmed" });

      const offering = await database.offering.findUnique({ where: { id: offeringId } });
      expect(offering?.effectiveRightsEndAt).toEqual(new Date("2026-09-09T12:00:00.000Z"));
    });

    it("reports offering_not_found for an unknown offering", async () => {
      const result = await repository.classifyMateriality({
        offeringId: `offering_missing_${suffix}`,
        accountId: "account_founder",
        changeDescription: "notes",
        classification: "non_material",
        thresholdType: null,
        traceId: `trace_${suffix}`,
        classifiedAt: new Date(),
      });

      expect(result).toEqual({ classified: null, conflict: "offering_not_found" });
    });

    it("reports no_active_reconfirmation_window before final terms are published", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });

      const result = await repository.classifyMateriality({
        offeringId,
        accountId: "account_founder",
        changeDescription: "notes",
        classification: "non_material",
        thresholdType: null,
        traceId: `trace_${suffix}`,
        classifiedAt: new Date(),
      });

      expect(result).toEqual({ classified: null, conflict: "no_active_reconfirmation_window" });
    });

    it("reports no_active_reconfirmation_window once the offering has already committed to final_offering", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00", status: "final_offering" });

      const result = await repository.classifyMateriality({
        offeringId,
        accountId: "account_founder",
        changeDescription: "notes",
        classification: "non_material",
        thresholdType: null,
        traceId: `trace_${suffix}`,
        classifiedAt: new Date(),
      });

      expect(result).toEqual({ classified: null, conflict: "no_active_reconfirmation_window" });
    });

    it("publishes an initial disclosure pack as version 1, with no prior pack to supersede", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const publishedAt = new Date("2026-09-01T09:00:00.000Z");

      const result = await repository.publishDisclosurePack({
        offeringId,
        accountId: "account_founder",
        documents: [
          { documentType: "ecsp_kiis", documentRef: "documents/kiis-v1.pdf" },
          { documentType: "final_terms_sheet", documentRef: "documents/terms-v1.pdf" },
        ],
        traceId: `trace_${suffix}`,
        publishedAt,
      });

      expect(result.conflict).toBeNull();
      expect(result.published).toMatchObject({
        offeringId,
        version: 1,
        publishedAt,
        isComplete: false,
        supersededPackId: null,
      });
      expect(result.published?.documents).toHaveLength(2);
      expect(result.published?.documents.find((d) => d.documentType === "ecsp_kiis")).toMatchObject({
        documentRef: "documents/kiis-v1.pdf",
        isCoreReading: true,
      });

      if (result.published === null) throw new Error("expected a published disclosure pack");
      const pack = await database.disclosurePack.findUnique({ where: { id: result.published.disclosurePackId } });
      expect(pack).toMatchObject({ offeringId, version: 1, isCurrent: true, supersededAt: null });

      const documents = await database.disclosureDocument.findMany({
        where: { disclosurePackId: result.published.disclosurePackId },
      });
      expect(documents).toHaveLength(2);

      expect(
        await database.auditLog.count({
          where: { resourceId: offeringId, action: "offering.disclosure_pack_published" },
        }),
      ).toBe(1);
    });

    it("supersedes the prior current pack and increments the version, reporting completeness once every mandatory document is present", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const first = await repository.publishDisclosurePack({
        offeringId,
        accountId: "account_founder",
        documents: [{ documentType: "ecsp_kiis", documentRef: "documents/kiis-v1.pdf" }],
        traceId: `trace_${suffix}`,
        publishedAt: new Date("2026-09-01T09:00:00.000Z"),
      });
      if (first.published === null) throw new Error("expected the first pack to publish");

      const republishedAt = new Date("2026-09-02T12:00:00.000Z");
      const second = await repository.publishDisclosurePack({
        offeringId,
        accountId: "account_founder",
        documents: [
          { documentType: "ecsp_kiis", documentRef: "documents/kiis-v2.pdf" },
          { documentType: "priips_kid", documentRef: "documents/kid-v2.pdf" },
          { documentType: "final_offer_summary", documentRef: "documents/offer-summary-v2.pdf" },
          { documentType: "final_terms_sheet", documentRef: "documents/terms-v2.pdf" },
          { documentType: "issuer_offeror_structure_sheet", documentRef: "documents/structure-v2.pdf" },
          {
            documentType: "investor_rights_payout_waterfall_summary",
            documentRef: "documents/rights-v2.pdf",
          },
          { documentType: "risk_factors_summary", documentRef: "documents/risks-v2.pdf" },
          { documentType: "property_appraisal_summary", documentRef: "documents/appraisal-v2.pdf" },
          { documentType: "fees_costs_tax_liquidity_summary", documentRef: "documents/fees-v2.pdf" },
          {
            documentType: "withdrawal_cancellation_supplement_rights_notice",
            documentRef: "documents/withdrawal-v2.pdf",
          },
          { documentType: "full_prospectus", documentRef: "documents/prospectus-v2.pdf" },
        ],
        traceId: `trace_${suffix}`,
        publishedAt: republishedAt,
      });

      expect(second.conflict).toBeNull();
      expect(second.published).toMatchObject({
        offeringId,
        version: 2,
        publishedAt: republishedAt,
        isComplete: true,
        supersededPackId: first.published.disclosurePackId,
      });
      expect(second.published?.documents.find((d) => d.documentType === "full_prospectus")).toMatchObject({
        isCoreReading: false,
      });

      const supersededPack = await database.disclosurePack.findUnique({
        where: { id: first.published.disclosurePackId },
      });
      expect(supersededPack).toMatchObject({ isCurrent: false, supersededAt: republishedAt });

      if (second.published === null) throw new Error("expected the second pack to publish");
      const currentPack = await database.disclosurePack.findUnique({ where: { id: second.published.disclosurePackId } });
      expect(currentPack).toMatchObject({ isCurrent: true, version: 2 });
    });

    it("reports offering_not_found for an unknown offering", async () => {
      const result = await repository.publishDisclosurePack({
        offeringId: `offering_missing_${suffix}`,
        accountId: "account_founder",
        documents: [{ documentType: "ecsp_kiis", documentRef: "documents/kiis-v1.pdf" }],
        traceId: `trace_${suffix}`,
        publishedAt: new Date(),
      });

      expect(result).toEqual({ published: null, conflict: "offering_not_found" });
    });

    it("reports not_open once the offering has already committed to final_offering", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00", status: "final_offering" });

      const result = await repository.publishDisclosurePack({
        offeringId,
        accountId: "account_founder",
        documents: [{ documentType: "ecsp_kiis", documentRef: "documents/kiis-v1.pdf" }],
        traceId: `trace_${suffix}`,
        publishedAt: new Date(),
      });

      expect(result).toEqual({ published: null, conflict: "not_open" });
    });

    it("reads a positive reconfirmation reminder interval from platform settings", async () => {
      const hours = await repository.getReconfirmationReminderIntervalHours();
      expect(Number.isInteger(hours)).toBe(true);
      expect(hours).toBeGreaterThan(0);
    });

    it("lists a reservation awaiting reconfirmation for reminders, reflecting the most recently recorded reminder", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "txn_reminder_01",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(),
      });
      const publishedAt = new Date("2026-09-02T12:00:00.000Z");
      await publishCompleteDisclosurePack(offeringId, publishedAt);
      await repository.publishFinalOfferingTerms({
        offeringId,
        accountId: "account_founder",
        founderReviewNotes: "notes",
        traceId: `trace_${suffix}`,
        publishedAt,
      });

      const account = await database.account.findUnique({ where: { id: fundedAccountId } });

      const beforeAnyReminder = await repository.listReservationsAwaitingReconfirmationForReminders();
      const candidate = beforeAnyReminder.find((r) => r.reservationId === reservationId);
      expect(candidate).toMatchObject({
        accountId: fundedAccountId,
        contactEmail: account?.protectedContactEmail ?? null,
        offeringId,
        finalOfferingPublishedAt: publishedAt,
        effectiveRightsEndAt: new Date("2026-09-09T12:00:00.000Z"),
        lastReminderSentAt: null,
      });

      const firstReminderAt = new Date("2026-09-04T12:00:00.000Z");
      await repository.recordReconfirmationReminderSent({
        reservationId,
        traceId: `trace_${suffix}`,
        sentAt: firstReminderAt,
      });
      const afterFirstReminder = await repository.listReservationsAwaitingReconfirmationForReminders();
      expect(
        afterFirstReminder.find((r) => r.reservationId === reservationId),
      ).toMatchObject({ lastReminderSentAt: firstReminderAt });

      const secondReminderAt = new Date("2026-09-06T12:00:00.000Z");
      await repository.recordReconfirmationReminderSent({
        reservationId,
        traceId: `trace_${suffix}`,
        sentAt: secondReminderAt,
      });
      const afterSecondReminder = await repository.listReservationsAwaitingReconfirmationForReminders();
      expect(
        afterSecondReminder.find((r) => r.reservationId === reservationId),
      ).toMatchObject({ lastReminderSentAt: secondReminderAt });

      expect(
        await database.auditLog.count({
          where: { resourceId: reservationId, action: "offering.reconfirmation_reminder_sent" },
        }),
      ).toBe(2);
    });

    it("excludes a reservation that is not awaiting reconfirmation", async () => {
      const { offeringId } = await createOffering({ targetRaiseEur: "1000.00" });
      const reservationId = `reservation_${randomUUID()}`;
      await repository.createReservation({
        reservationId,
        offeringId,
        accountId: fundedAccountId,
        amountEur: "1000.00",
        disclosurePackVersionAtReservation: null,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
      });

      const candidates = await repository.listReservationsAwaitingReconfirmationForReminders();
      expect(candidates.find((r) => r.reservationId === reservationId)).toBeUndefined();
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "origination approval offering handoff PostgreSQL integration",
  () => {
    const suffix = randomUUID();
    const accountId = `account_handoff_${suffix}`;
    const betterAuthUserId = `auth_handoff_${suffix}`;
    const propertyId = `property_handoff_${suffix}`;
    const caseId = `case_handoff_${suffix}`;
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    // PgBoss's constructor eagerly validates its connection string, so it
    // must not be constructed at describe-body scope (see the first
    // describe block's comment for why).
    let boss: PgBoss;
    let repository: PrismaOfferingRepository;
    let pivId = "";
    let offeringId = "";

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      repository = new PrismaOfferingRepository(database, boss);
      await boss.start();
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserId, "Handoff Repository Applicant", `handoff-repo-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId } });
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "RS",
          city: "Novi Sad",
          addressLine: "Repository Handoff Test 1",
          ownerDeclaredValueEur: "220000.00",
        },
      });
      await database.originationCase.create({
        data: {
          id: caseId,
          propertyId,
          applicantAccountId: accountId,
          stage: "pre_offering_open",
          legalExecutionEventRefs: [],
          legalDocumentRefs: [],
          appraisalDocumentRefs: [],
        },
      });
    });

    afterAll(async () => {
      await database.auditLog.deleteMany({
        where: offeringId === "" ? { resourceId: caseId } : { resourceId: offeringId, resourceType: "offering" },
      });
      if (pivId !== "") {
        await database.offering.deleteMany({ where: { pivId } });
        await database.piv.deleteMany({ where: { id: pivId } });
      }
      await database.originationCase.deleteMany({ where: { id: caseId } });
      await database.property.deleteMany({ where: { id: propertyId } });
      await database.account.deleteMany({ where: { id: accountId } });
      await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
      await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
    });

    it("opens a browsable pre-offering shell and is idempotent on replay", async () => {
      const opened = await repository.openOfferingForApprovedCase({
        caseId,
        propertyId,
        ipoValueEur: "220000.00",
        traceId: `trace_${suffix}`,
        openedAt: new Date("2026-09-01T19:00:00.000Z"),
      });
      pivId = opened.pivId;
      offeringId = opened.offeringId;

      expect(await database.piv.findUnique({ where: { id: opened.pivId } })).toMatchObject({
        propertyId,
        caseId,
        structurePattern: "default_aligned",
        legalName: null,
        incorporatedAt: null,
      });
      const offering = await database.offering.findUnique({ where: { id: opened.offeringId } });
      expect(offering).toMatchObject({ pivId: opened.pivId, status: "pre_offering" });
      expect(offering?.minimumRaiseEur.toFixed(2)).toBe("220000.00");
      expect(offering?.targetRaiseEur.toFixed(2)).toBe("220000.00");
      expect(
        await database.auditLog.count({
          where: { resourceId: opened.offeringId, action: "offering.opened_for_approved_case" },
        }),
      ).toBe(1);

      const replayed = await repository.openOfferingForApprovedCase({
        caseId,
        propertyId,
        ipoValueEur: "220000.00",
        traceId: `trace_replay_${suffix}`,
        openedAt: new Date("2026-09-01T19:05:00.000Z"),
      });

      expect(replayed).toEqual(opened);
      expect(await database.piv.count({ where: { propertyId } })).toBe(1);
      expect(await database.offering.count({ where: { pivId: opened.pivId } })).toBe(1);
      expect(
        await database.auditLog.count({
          where: { resourceId: opened.offeringId, action: "offering.opened_for_approved_case" },
        }),
      ).toBe(1);
    });
  },
);
