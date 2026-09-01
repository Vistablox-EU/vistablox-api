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
  const diditReference = randomUUID();
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
            methodType: "email_password",
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
  });

  afterAll(async () => {
    await database.walletRegistration.deleteMany({ where: { accountId } });
    await database.kycEligibility.deleteMany({ where: { accountId } });
    await database.loginMethod.deleteMany({ where: { accountId } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("reads the cross-schema profile aggregate without storing a duplicate profile", async () => {
    await expect(repository.get(accountId)).resolves.toMatchObject({
      accountId,
      accountStatus: "active",
      protectedContactEmail: `profile-${suffix}@example.test`,
      loginMethods: [{ methodType: "email_password", linkedAt }],
      kyc: {
        diditReference,
        providerStatus: "Approved",
        eligibilityState: "eligible",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
      },
      reservationCount: 0,
      activePositionCount: 0,
      walletRegistration: { requestedAt, registeredAt: null },
    });
  });
});
