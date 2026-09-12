import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaStaffBootstrapRepository } from "../src/modules/auth/repository/prisma-staff-bootstrap.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)(
  "PrismaStaffBootstrapRepository PostgreSQL integration",
  () => {
    const database = createPrismaClient(databaseUrl ?? "");
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new PrismaStaffBootstrapRepository(database);

    afterAll(async () => {
      await pool.end();
      await database.$disconnect();
    });

    function issueInput(overrides: Partial<Parameters<typeof repository.issueBootstrapInvitation>[0]> = {}) {
      const suffix = randomUUID();
      return {
        email: `bootstrap-${suffix}@example.test`,
        displayName: "Bootstrap Test Admin",
        tokenHash: `hash_${suffix}`,
        traceId: `trace_${suffix}`,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
        ...overrides,
      };
    }

    it("issues a bootstrap invitation with no issuer, marked cli_bootstrap", async () => {
      const result = await repository.issueBootstrapInvitation(issueInput());

      expect(result.outcome).toBe("issued");
      if (result.outcome !== "issued") return;

      const row = await database.staffInvitation.findUniqueOrThrow({
        where: { id: result.invitationId },
      });
      expect(row.invitedByAccountId).toBeNull();
      expect(row.issuedVia).toBe("cli_bootstrap");
      expect(row.role).toBe("admin_operations");
    });

    it("refuses when an active account already holds admin_operations", async () => {
      const suffix = randomUUID();
      const accountId = `acct_${suffix}`;
      await database.account.create({
        data: { id: accountId, betterAuthUserId: `bau_${suffix}`, status: "active" },
      });
      await database.staffRoleAssignment.create({
        data: { id: `role_${suffix}`, accountId, role: "admin_operations" },
      });

      const result = await repository.issueBootstrapInvitation(issueInput());

      expect(result).toEqual({ outcome: "admin_exists" });
    });

    it("serializes two concurrent runs to exactly one live bootstrap invitation", async () => {
      const suffix = randomUUID();
      const email = `bootstrap-concurrent-${suffix}@example.test`;

      const [first, second] = await Promise.all([
        repository.issueBootstrapInvitation(issueInput({ email })),
        repository.issueBootstrapInvitation(issueInput({ email: `bootstrap-concurrent-b-${suffix}@example.test` })),
      ]);

      expect(first.outcome).toBe("issued");
      expect(second.outcome).toBe("issued");

      const liveBootstrapRows = await database.staffInvitation.findMany({
        where: { issuedVia: "cli_bootstrap", acceptedAt: null, revokedAt: null },
      });
      // Whichever ran second revoked the first's still-live invitation before
      // creating its own -- the advisory lock means this is never a race:
      // there is exactly one winner, never zero and never two.
      expect(liveBootstrapRows).toHaveLength(1);
    });

    it("the partial unique index refuses a second live bootstrap row even outside the repository", async () => {
      const first = await repository.issueBootstrapInvitation(issueInput());
      expect(first.outcome).toBe("issued");

      const suffix = randomUUID();
      await expect(
        pool.query(
          `INSERT INTO "auth"."staff_invitations"
             ("invitation_id", "email", "display_name", "role", "token_hash",
              "invited_by_account_id", "issued_via", "expires_at")
           VALUES ($1, $2, $3, 'admin_operations', $4, NULL, 'cli_bootstrap', now() + interval '72 hours')`,
          [`invite_${suffix}`, `bootstrap-direct-${suffix}@example.test`, "Direct Insert", `hash_${suffix}`],
        ),
      ).rejects.toThrow(/staff_invitations_one_pending_bootstrap_key/);
    });

    it("the CHECK constraint refuses a cli_bootstrap row with a non-null issuer", async () => {
      const suffix = randomUUID();
      const accountId = `acct_issuer_${suffix}`;
      await database.account.create({
        data: { id: accountId, betterAuthUserId: `bau_issuer_${suffix}`, status: "active" },
      });

      await expect(
        pool.query(
          `INSERT INTO "auth"."staff_invitations"
             ("invitation_id", "email", "display_name", "role", "token_hash",
              "invited_by_account_id", "issued_via", "expires_at")
           VALUES ($1, $2, 'Bad Row', 'admin_operations', $3, $4, 'cli_bootstrap', now() + interval '72 hours')`,
          [`invite_${suffix}`, `bootstrap-bad-${suffix}@example.test`, `hash_${suffix}`, accountId],
        ),
      ).rejects.toThrow(/staff_invitations_issued_via_check/);
    });
  },
);
