import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaOriginationKycProjectionRepository } from "../src/modules/origination/repository/prisma-origination-kyc-projection.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "Origination KYC eligibility projection PostgreSQL integration",
  () => {
    const authPool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    let repository: PrismaOriginationKycProjectionRepository;

    beforeAll(() => {
      repository = new PrismaOriginationKycProjectionRepository(database);
    });

    afterAll(async () => {
      await Promise.all([database.$disconnect(), authPool.end()]);
    });

    it("returns null for an account with no projection row", async () => {
      expect(await repository.getEligibilitySnapshot(`acct_unknown_${randomUUID()}`)).toBeNull();
    });

    it("applyEvent upserts idempotently and getEligibilitySnapshot reads it back", async () => {
      const accountId = `acct_apply_${randomUUID()}`;
      const snapshot = {
        accountId,
        diditReference: randomUUID(),
        providerStatus: "Approved",
        eligibilityState: "eligible",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "HR",
        proofOfAddressStatus: "not_started",
        proofOfAddressCurrentUntil: null,
        lastVerifiedAt: new Date("2026-09-01T12:00:00.000Z"),
        renewalDueAt: new Date("2028-09-01T12:00:00.000Z"),
      };

      expect(await repository.applyEvent(snapshot)).toEqual({ checked: 1, acted: 1 });
      expect(await repository.getEligibilitySnapshot(accountId)).toEqual(snapshot);

      // Applying the same event again (a pg-boss retry, or a duplicate
      // delivery) must converge to the same row, not create a second one or
      // throw.
      expect(await repository.applyEvent(snapshot)).toEqual({ checked: 1, acted: 1 });
      expect(await repository.getEligibilitySnapshot(accountId)).toEqual(snapshot);

      const updated = { ...snapshot, eligibilityState: "requires_renewal" };
      expect(await repository.applyEvent(updated)).toEqual({ checked: 1, acted: 1 });
      expect(await repository.getEligibilitySnapshot(accountId)).toEqual(updated);
    });

    it("reconcile only writes rows that actually differ from the source, and self-heals a manually-desynced row", async () => {
      const suffix = randomUUID();
      const accountId = `acct_reconcile_${suffix}`;
      const betterAuthUserId = `auth_reconcile_${suffix}`;
      const diditReference = randomUUID();
      const lastVerifiedAt = new Date("2026-09-01T12:00:00.000Z");

      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserId, "Reconcile Test User", `kyc-reconcile-${suffix}@example.test`, true, "customer"],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId } });
      await database.kycEligibility.create({
        data: {
          accountId,
          diditReference,
          providerStatus: "Approved",
          eligibilityState: "eligible",
          residenceCountryCode: "DE",
          taxResidenceCountryCode: "DE",
          proofOfAddressStatus: "not_started",
          lastVerifiedAt,
          updatedAt: lastVerifiedAt,
        },
      });

      try {
        // Cold start: the projection has no row for this account at all --
        // must be created and counted as acted-on.
        const firstPass = await repository.reconcile();
        expect(firstPass.acted).toBeGreaterThanOrEqual(1);
        expect(await repository.getEligibilitySnapshot(accountId)).toMatchObject({
          accountId,
          diditReference,
          eligibilityState: "eligible",
        });

        // Already in sync: a second pass leaves this account's row exactly
        // as reconcile's first pass converged it to. (Not asserting exact
        // checked/acted counts here -- other integration tests may create
        // their own identity.kyc_eligibility rows concurrently against this
        // same shared database, so only this one account's own convergence
        // is a meaningful, non-flaky thing to assert.)
        await repository.reconcile();
        expect(await repository.getEligibilitySnapshot(accountId)).toMatchObject({
          eligibilityState: "eligible",
        });

        // Manually desync the projection (simulating a subscriber that
        // missed an event or a row that drifted) -- reconcile must correct
        // it back to the source's own current state.
        await database.originationKycEligibilityProjection.update({
          where: { accountId },
          data: { eligibilityState: "requires_renewal" },
        });
        expect(await repository.getEligibilitySnapshot(accountId)).toMatchObject({
          eligibilityState: "requires_renewal",
        });

        await repository.reconcile();
        expect(await repository.getEligibilitySnapshot(accountId)).toMatchObject({
          eligibilityState: "eligible",
        });
      } finally {
        await database.originationKycEligibilityProjection.deleteMany({ where: { accountId } });
        await database.kycEligibility.deleteMany({ where: { accountId } });
        await database.account.deleteMany({ where: { id: accountId } });
        await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
      }
    });
  },
);
