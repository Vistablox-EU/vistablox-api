import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { GetWalletStatusService } from "../src/modules/wallet/application/get-wallet-status.service.js";
import { RequestWalletTransferService } from "../src/modules/wallet/application/request-wallet-transfer.service.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import { PrismaSettlementRepository } from "../src/modules/settlement/repository/prisma-settlement.repository.js";
import { buildTransferChainReader } from "./support/wallet-transfer-fakes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// Real wallet repository and real holdings reader against PostgreSQL, a fake
// chain reader. What this proves that the service unit tests cannot: the row
// a pending claim leaves in settlement.wallet_registrations really does come
// back from findByAccountId with registeredAt null, the guard refuses it
// before the chain is read, GET /wallet's reader still reports it as pending,
// and the same account is served once registered_at is set.
//
// The rows are created and confirmed with direct Prisma writes on purpose,
// not through registerWallet, confirmWalletRegistration or
// reconcileWalletRegistration. This test is about how the transfer service
// reads a row, not about how a row gets confirmed (that is covered by the
// confirm and reconcile tests), and it must not break when those signatures
// change. findByAccountId(accountId) and listTokenHoldings(accountId) are the
// only repository entry points used.
describe.skipIf(databaseUrl === undefined)("transfer preparation needs a confirmed wallet registration", () => {
  const suffix = randomUUID();
  const hex12 = suffix.replace(/-/g, "").slice(0, 12);
  const accountId = `account_transfer_confirmed_${suffix}`;
  const betterAuthUserId = `auth_transfer_confirmed_${suffix}`;
  const propertyId = `property_transfer_confirmed_${suffix}`;
  const caseId = `case_transfer_confirmed_${suffix}`;
  const pivId = `piv_transfer_confirmed_${suffix}`;
  const positionId = `position_transfer_confirmed_${suffix}`;
  // Same scheme as settlement-repository.integration.test.ts: derived from the
  // suffix, so it cannot collide with the sequence-assigned ids other suites use.
  const tokenId = (BigInt(`0x${hex12}`) * 100n + 7n).toString();
  // Stored lowercase, as the registration route stores it.
  const walletAddress = `0x${randomBytes(20).toString("hex")}`;
  const toWalletAddress = "0x00000000219ab540356cbb839cbe05303d7705fa";

  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const walletRepository = new PrismaWalletRepository(database);
  const settlementRepository = new PrismaSettlementRepository(database);

  beforeAll(async () => {
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Transfer Confirmed Test Investor", `transfer-confirmed-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({ data: { id: accountId, betterAuthUserId } });
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "RS",
        city: "Belgrade",
        addressLine: `Transfer Confirmed Test ${suffix}`,
        ownerDeclaredValueEur: "100000.00",
      },
    });
    await database.intakeCase.create({
      data: {
        id: caseId,
        propertyId,
        applicantAccountId: accountId,
        stage: "pre_offering_open",
        legalExecutionEventRefs: [],
        legalDocumentRefs: [],
        appraisalDocumentRefs: [],
        ipoEndAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await database.piv.create({ data: { id: pivId, propertyId, caseId, tokenId } });
    // The account holds a minted position, so the only thing that can refuse
    // the transfer before the chain read is the wallet row itself.
    await database.positionLedger.create({
      data: { id: positionId, pivId, accountId, unitCount: "10.000000", costBasisEur: "10.00" },
    });
  });

  afterAll(async () => {
    await database.positionLedger.deleteMany({ where: { pivId } });
    await database.piv.deleteMany({ where: { id: pivId } });
    await database.intakeCase.deleteMany({ where: { id: caseId } });
    await database.property.deleteMany({ where: { id: propertyId } });
    await database.walletRegistration.deleteMany({ where: { accountId } });
    await database.account.deleteMany({ where: { id: accountId } });
    await authPool.query('DELETE FROM "auth_user" WHERE "id" = $1', [betterAuthUserId]);
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  it("refuses with no wallet row, refuses a pending claim without reading the chain, and serves the same account once it is confirmed", async () => {
    const chainReader = buildTransferChainReader();
    const service = new RequestWalletTransferService(walletRepository, settlementRepository, chainReader);
    const prepare = () => service.execute({ accountId, pivId, toWalletAddress, amount: "3" });

    // 1. No row at all.
    await expect(prepare()).rejects.toMatchObject({ code: "wallet.not_registered", status: 404 });
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();

    // 2. A pending claim: the row exists, registered_at is null.
    await database.walletRegistration.create({
      data: {
        accountId,
        walletAddress,
        registrationCommitment: `0x${"ab".repeat(32)}`,
        requestedAt: new Date("2026-09-02T10:00:00.000Z"),
      },
    });
    expect(await walletRepository.findByAccountId(accountId)).toMatchObject({
      walletAddress,
      registeredAt: null,
    });

    const pending = (await prepare().catch((caught: unknown) => caught)) as Error & { code?: string };
    expect(pending).toMatchObject({ code: "wallet.not_registered", status: 404 });
    expect(pending.message).toMatch(/not confirmed/);
    expect(chainReader.readTransferSnapshot).not.toHaveBeenCalled();

    // The status read is a different question and still reports the pending claim.
    await expect(new GetWalletStatusService(walletRepository).execute(accountId)).resolves.toMatchObject({
      data: { wallet_address: walletAddress, status: "pending", registered_at: null },
    });

    // 3. Confirmed: the same account, the same request, now served.
    await database.walletRegistration.update({
      where: { accountId },
      data: { registeredAt: new Date("2026-09-02T10:05:00.000Z") },
    });

    const prepared = await prepare();

    expect(prepared.data).toMatchObject({
      piv_id: pivId,
      token_id: tokenId,
      from_wallet_address: walletAddress,
      to_wallet_address: toWalletAddress,
    });
    expect(chainReader.readTransferSnapshot).toHaveBeenCalledTimes(1);
    expect(chainReader.readTransferSnapshot).toHaveBeenCalledWith({
      from: walletAddress,
      to: toWalletAddress,
      tokenId,
      amount: "3",
    });
    await expect(new GetWalletStatusService(walletRepository).execute(accountId)).resolves.toMatchObject({
      data: { status: "registered" },
    });
  });
});
