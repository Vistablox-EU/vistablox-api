import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createBetterAuth } from "../src/modules/auth/infrastructure/shared/better-auth.factory.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "auth_user_staff_lifecycle_population_check PostgreSQL integration",
  () => {
    const suffix = randomUUID();
    const authPool = new Pool({ connectionString: databaseUrl });
    const auth = createBetterAuth({
      database: authPool,
      baseURL: "http://localhost:3000",
      secret: "integration-test-secret-that-is-at-least-32-characters",
      secureCookies: false,
      trustedOrigins: ["http://localhost:3000"],
      allowPopulationInput: true,
    });

    afterAll(async () => {
      await authPool.end();
    });

    it("allows recoveryRequiredAt on a customer user", async () => {
      const context = await auth.$context;
      const customer = await context.internalAdapter.createUser(
        {
          name: "Recovery Flag Test Customer",
          email: `recovery-flag-${suffix}@example.test`,
          emailVerified: true,
          population: "customer",
        },
        { method: "internal" },
      );

      await expect(
        context.internalAdapter.updateUser(customer.id, { recoveryRequiredAt: new Date() }),
      ).resolves.toMatchObject({ id: customer.id });
    });

    it("still refuses disabledAt/disabledReason on a customer user", async () => {
      const context = await auth.$context;
      const customer = await context.internalAdapter.createUser(
        {
          name: "Disable Regression Test Customer",
          email: `disable-regression-${suffix}@example.test`,
          emailVerified: true,
          population: "customer",
        },
        { method: "internal" },
      );

      await expect(
        authPool.query(
          `UPDATE "auth_user" SET "disabledAt" = now(), "disabledReason" = 'security_action' WHERE "id" = $1`,
          [customer.id],
        ),
      ).rejects.toThrow(/auth_user_staff_lifecycle_population_check/);
    });
  },
);
