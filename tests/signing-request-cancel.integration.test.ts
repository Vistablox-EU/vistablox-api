import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaSigningRequestRepository } from "../src/modules/auth/repository/customer/prisma-signing-request.repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// D3 cancellation is scoped to (account, device): another account's requests
// are never touched, even when its device id is passed in.
describe.skipIf(databaseUrl === undefined)("signing-request cancellation by account and device, PostgreSQL", () => {
  const suffix = randomUUID();
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const repository = new PrismaSigningRequestRepository(database);
  const accountA = `acct_cancel_a_${suffix}`;
  const accountB = `acct_cancel_b_${suffix}`;
  const deviceA = `device_cancel_a_${suffix}`;
  const deviceB = `device_cancel_b_${suffix}`;

  async function seed(accountId: string, deviceId: string, label: string): Promise<void> {
    const userId = `auth_cancel_${label}_${suffix}`;
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [userId, "Cancel Scope User", `${userId}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId: userId } });
    await database.device.create({
      data: {
        deviceId,
        accountId,
        betterAuthUserId: userId,
        dpopJkt: `dpop_${label}_${suffix}`,
        bioJkt: `bio_${label}_${suffix}`,
        biometricPublicJwk: {},
        platform: "android",
        attestationMetadata: {},
      },
    });
  }

  async function statuses(accountId: string): Promise<string[]> {
    const rows = await repository.listForAccount(accountId);
    return rows.map((row) => row.status);
  }

  async function createRequest(accountId: string, deviceId: string) {
    return repository.create({
      accountId,
      deviceId,
      requestType: "withdrawal",
      amountMinor: "1000",
      currency: "EUR",
      destination: null,
      createdBy: { kind: "user", label: "Test" },
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  }

  beforeAll(async () => {
    await seed(accountA, deviceA, "a");
    await seed(accountB, deviceB, "b");
    await createRequest(accountA, deviceA);
    await createRequest(accountB, deviceB);
  });

  afterAll(async () => {
    await database.signingRequest.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await database.device.deleteMany({ where: { accountId: { in: [accountA, accountB] } } });
    await database.account.deleteMany({ where: { id: { in: [accountA, accountB] } } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" LIKE $1', [`auth_cancel_%_${suffix}`]);
    await authPool.end();
    await database.$disconnect();
  });

  it("cancels nothing when the device belongs to another account", async () => {
    await expect(repository.cancelPendingAndSignedForDevice(accountA, deviceB)).resolves.toBe(0);
    expect(await statuses(accountB)).toEqual(["pending"]);
  });

  it("cancels only the named account's requests for its own device", async () => {
    await expect(repository.cancelPendingAndSignedForDevice(accountA, deviceA)).resolves.toBe(1);
    expect(await statuses(accountA)).toEqual(["cancelled"]);
    expect(await statuses(accountB)).toEqual(["pending"]);
  });
});
