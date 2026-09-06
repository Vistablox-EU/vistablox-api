import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaInvestorProfileRepository } from "../src/modules/investor-profile/repository/prisma-investor-profile.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("investor profile PostgreSQL integration", () => {
  const suffix = randomUUID();
  const accountId = `acct_${suffix}`;
  const betterAuthUserId = `auth_${suffix}`;
  const otherAccountId = `acct_other_${suffix}`;
  const otherBetterAuthUserId = `auth_other_${suffix}`;
  const diditReference = randomUUID();
  const propertyId = `property_${suffix}`;
  const caseId = `case_${suffix}`;
  const pivId = `piv_${suffix}`;
  const offeringId = `offering_${suffix}`;
  const reservationIds = [
    `reservation_a_${suffix}`,
    `reservation_b_${suffix}`,
    `reservation_c_${suffix}`,
  ];
  const otherReservationId = `reservation_other_${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaInvestorProfileRepository(database);
  const linkedAt = new Date("2026-01-15T10:00:00.000Z");
  const requestedAt = new Date("2026-08-10T12:00:00.000Z");

  beforeAll(async () => {
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [
        betterAuthUserId,
        "Investor Profile Test",
        `profile-${suffix}@example.test`,
        true,
        "customer",
      ],
    );
    await database.account.create({
      data: {
        id: accountId,
        betterAuthUserId,
        protectedContactEmail: `profile-${suffix}@example.test`,
        loginMethods: {
          create: {
            id: `login_${suffix}`,
            methodType: "apple",
            providerSubject: betterAuthUserId,
            linkedAt,
          },
        },
        kycEligibility: {
          create: {
            diditReference,
            providerStatus: "Approved",
            eligibilityState: "eligible",
            operationalSubstatus: "kyc_verified_owner_poa_missing",
            residenceCountryCode: "DE",
            taxResidenceCountryCode: "HR",
            proofOfAddressStatus: "not_started",
          },
        },
        walletRegistration: {
          create: {
            walletAddress: `0x${suffix.replaceAll("-", "")}`,
            registrationCommitment: `commitment_${suffix}`,
            requestedAt,
          },
        },
      },
    });
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [
        otherBetterAuthUserId,
        "Other Investor",
        `profile-other-${suffix}@example.test`,
        true,
        "customer",
      ],
    );
    await database.account.create({
      data: { id: otherAccountId, betterAuthUserId: otherBetterAuthUserId },
    });
    await database.property.create({
      data: {
        id: propertyId,
        propertyType: "residential",
        countryCode: "DE",
        city: "Berlin",
        ownerDeclaredValueEur: "500000.00",
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
    await database.piv.create({ data: { id: pivId, propertyId, caseId } });
    await database.offering.create({
      data: {
        id: offeringId,
        pivId,
        minimumRaiseEur: "250000.00",
        targetRaiseEur: "500000.00",
        status: "final_offering",
      },
    });
    await database.reservation.createMany({
      data: [
        {
          id: reservationIds[0]!,
          offeringId,
          accountId,
          amountEur: "3000.00",
          reservationStage: "finalized",
          disclosurePackVersionAtReservation: "3",
          reconfirmedAt: new Date("2026-09-03T11:00:00.000Z"),
          reservationFinalizedAt: new Date("2026-09-03T12:00:00.000Z"),
          createdAt: new Date("2026-09-03T10:00:00.000Z"),
        },
        {
          id: reservationIds[1]!,
          offeringId,
          accountId,
          amountEur: "2000.00",
          reservationStage: "finalized",
          createdAt: new Date("2026-09-02T10:00:00.000Z"),
        },
        {
          id: reservationIds[2]!,
          offeringId,
          accountId,
          amountEur: "1000.00",
          reservationStage: "finalized",
          createdAt: new Date("2026-09-01T10:00:00.000Z"),
        },
        {
          id: otherReservationId,
          offeringId,
          accountId: otherAccountId,
          amountEur: "9999.00",
          reservationStage: "finalized",
          createdAt: new Date("2026-09-04T10:00:00.000Z"),
        },
      ],
    });
    await database.moneyEvent.createMany({
      data: [
        {
          id: `money_old_${suffix}`,
          reservationId: reservationIds[0]!,
          provider: "stripe_onramp",
          providerReference: `private_provider_ref_${suffix}`,
          capitalState: "eurc_reserved",
          amountEur: "3000.00",
          amountEurc: "2998.250000",
          recordedAt: new Date("2026-09-03T10:30:00.000Z"),
        },
        {
          id: `money_latest_${suffix}`,
          reservationId: reservationIds[0]!,
          provider: "internal",
          capitalState: "eurc_finalized",
          amountEur: "3000.00",
          amountEurc: "2998.250000",
          recordedAt: new Date("2026-09-03T12:00:00.000Z"),
        },
      ],
    });
    await database.positionLedger.createMany({
      data: [
        {
          id: `position_active_${suffix}`,
          reservationId: reservationIds[0]!,
          pivId,
          accountId,
          unitCount: "15.000000",
          costBasisEur: "3000.00",
          positionStatus: "active",
          holderWalletAddress: `0x${suffix.replaceAll("-", "")}`,
          activatedAt: new Date("2026-09-04T12:00:00.000Z"),
        },
        {
          id: `position_pending_${suffix}`,
          reservationId: reservationIds[1]!,
          pivId,
          accountId,
          unitCount: "10.000000",
          costBasisEur: "2000.00",
          positionStatus: "pending_internal_settlement",
        },
        {
          id: `position_redeemed_${suffix}`,
          reservationId: reservationIds[2]!,
          pivId,
          accountId,
          unitCount: "5.000000",
          costBasisEur: "1000.00",
          positionStatus: "redeemed",
          redeemedAt: new Date("2026-09-05T12:00:00.000Z"),
          redemptionProceedsEur: "1100.00",
        },
        {
          id: `position_other_${suffix}`,
          reservationId: otherReservationId,
          pivId,
          accountId: otherAccountId,
          unitCount: "99.000000",
          costBasisEur: "9999.00",
          positionStatus: "active",
          activatedAt: new Date("2026-09-06T12:00:00.000Z"),
        },
      ],
    });
  });

  afterAll(async () => {
    await database.positionLedger.deleteMany({
      where: { accountId: { in: [accountId, otherAccountId] } },
    });
    await database.moneyEvent.deleteMany({
      where: { reservation: { accountId } },
    });
    await database.reservation.deleteMany({
      where: { accountId: { in: [accountId, otherAccountId] } },
    });
    await database.offering.deleteMany({ where: { id: offeringId } });
    await database.piv.deleteMany({ where: { id: pivId } });
    await database.originationCase.deleteMany({ where: { id: caseId } });
    await database.property.deleteMany({ where: { id: propertyId } });
    await database.walletRegistration.deleteMany({
      where: { accountId: { in: [accountId, otherAccountId] } },
    });
    await database.kycEligibility.deleteMany({ where: { accountId } });
    await database.loginMethod.deleteMany({ where: { accountId } });
    await database.account.deleteMany({
      where: { id: { in: [accountId, otherAccountId] } },
    });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" IN ($1, $2)', [
      betterAuthUserId,
      otherBetterAuthUserId,
    ]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("reads the cross-schema profile aggregate without storing a duplicate profile", async () => {
    await expect(repository.get(accountId)).resolves.toMatchObject({
      accountId,
      accountStatus: "active",
      protectedContactEmail: `profile-${suffix}@example.test`,
      loginMethods: [{ methodType: "apple", linkedAt }],
      kyc: {
        diditReference,
        providerStatus: "Approved",
        eligibilityState: "eligible",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
      },
      reservationCount: 3,
      activePositionCount: 2,
      walletRegistration: { requestedAt, registeredAt: null },
    });
  });

  it("paginates account-scoped reservations and returns only the latest money state", async () => {
    const firstPage = await repository.listReservations({ accountId, limit: 2 });

    expect(firstPage).toHaveLength(2);
    expect(firstPage[0]).toMatchObject({
      reservationId: reservationIds[0],
      offeringId,
      amountEur: "3000.00",
      reservationStage: "finalized",
      latestMoneyEvent: {
        capitalState: "eurc_finalized",
        amountEurc: "2998.250000",
        recordedAt: new Date("2026-09-03T12:00:00.000Z"),
      },
      property: {
        propertyType: "residential",
        countryCode: "DE",
        city: "Berlin",
      },
    });
    expect(JSON.stringify(firstPage)).not.toContain("private_provider_ref");
    expect(JSON.stringify(firstPage)).not.toContain(otherReservationId);

    const secondPage = await repository.listReservations({
      accountId,
      limit: 2,
      after: {
        createdAt: firstPage[1]!.createdAt,
        id: firstPage[1]!.reservationId,
      },
    });
    expect(secondPage.map((row) => row.reservationId)).toEqual([
      reservationIds[2],
    ]);
  });

  it("lists active positions before pending positions and excludes redeemed holdings", async () => {
    const activePage = await repository.listCurrentPositions({
      accountId,
      limit: 1,
    });
    expect(activePage).toMatchObject([
      {
        positionId: `position_active_${suffix}`,
        positionStatus: "active",
        unitCount: "15.000000",
        costBasisEur: "3000.00",
      },
    ]);
    expect(JSON.stringify(activePage)).not.toContain("holderWalletAddress");
    expect(JSON.stringify(activePage)).not.toContain(`position_other_${suffix}`);

    const pendingPage = await repository.listCurrentPositions({
      accountId,
      limit: 2,
      after: {
        activatedAt: activePage[0]!.activatedAt,
        id: activePage[0]!.positionId,
      },
    });
    expect(pendingPage.map((row) => row.positionStatus)).toEqual([
      "pending_internal_settlement",
    ]);
  });

  it("registers a wallet, replays idempotently, and rejects address conflicts", async () => {
    const address = `0xnew${suffix.replaceAll("-", "")}`.slice(0, 42).padEnd(42, "0");

    const created = await repository.registerWallet({
      accountId: otherAccountId,
      walletAddress: address,
      registrationCommitment: `commitment_new_${suffix}`,
      requestedAt: new Date("2026-09-02T11:00:00.000Z"),
    });
    expect(created).toMatchObject({
      walletAddress: address,
      registrationCommitment: `commitment_new_${suffix}`,
      registeredAt: null,
    });

    const replayed = await repository.registerWallet({
      accountId: otherAccountId,
      walletAddress: address,
      registrationCommitment: `commitment_replayed_${suffix}`,
      requestedAt: new Date("2026-09-02T11:05:00.000Z"),
    });
    expect(replayed).toEqual(created);

    await expect(
      repository.registerWallet({
        accountId: otherAccountId,
        walletAddress: `0xdifferent${suffix.replaceAll("-", "")}`.slice(0, 42).padEnd(42, "0"),
        registrationCommitment: `commitment_mismatch_${suffix}`,
        requestedAt: new Date("2026-09-02T11:10:00.000Z"),
      }),
    ).rejects.toMatchObject({ reason: "address_mismatch" });

    expect(
      await database.auditLog.count({
        where: {
          resourceId: otherAccountId,
          action: "settlement.wallet_registration_requested",
        },
      }),
    ).toBe(1);
  });

  it("rejects registering an address already claimed by a different account", async () => {
    const thirdAccountId = `acct_third_${suffix}`;
    const thirdBetterAuthUserId = `auth_third_${suffix}`;
    const claimedAddress = `0xclaim${suffix.replaceAll("-", "")}`.slice(0, 42).padEnd(42, "0");
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [thirdBetterAuthUserId, "Third Investor", `profile-third-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({
      data: { id: thirdAccountId, betterAuthUserId: thirdBetterAuthUserId },
    });

    await database.walletRegistration.create({
      data: {
        accountId: thirdAccountId,
        walletAddress: claimedAddress,
        registrationCommitment: `commitment_claim_owner_${suffix}`,
        requestedAt: new Date("2026-09-02T11:20:00.000Z"),
      },
    });

    await expect(
      repository.registerWallet({
        accountId: otherAccountId,
        walletAddress: claimedAddress,
        registrationCommitment: `commitment_claim_attempt_${suffix}`,
        requestedAt: new Date("2026-09-02T11:25:00.000Z"),
      }),
    ).rejects.toMatchObject({ reason: "address_claimed" });

    await database.walletRegistration.deleteMany({ where: { accountId: thirdAccountId } });
    await database.account.deleteMany({ where: { id: thirdAccountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [thirdBetterAuthUserId]);
  });
});
