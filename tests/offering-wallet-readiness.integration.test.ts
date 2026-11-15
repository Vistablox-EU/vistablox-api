import { randomUUID } from "node:crypto";

import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import type { AppError } from "../src/shared/errors/app-error.js";
import { CreateReservationService } from "../src/modules/offering/application/create-reservation.service.js";
import type { CoinbaseCdpClient } from "../src/modules/offering/application/coinbase-cdp-client.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { PrismaWalletRepository } from "../src/modules/wallet/repository/prisma-wallet.repository.js";
import { WalletAddressConflictError } from "../src/modules/wallet/repository/wallet.repository.js";

// A pending wallet claim proves nothing about who controls the address, and
// its own account may replace it in place (#146). The address handed to the
// Coinbase onramp is where the investor's EURC is delivered, so it must come
// from a CONFIRMED registration only: otherwise a session that replaces the
// pending address could redirect the purchase, including through the replay of
// an idempotent reservation request that already exists. These tests drive the
// real wallet repository, the real offering read model and the real
// CreateReservationService; only the Coinbase client is a stub.
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("offering wallet readiness PostgreSQL integration", () => {
  const suffix = randomUUID();
  const hex = suffix.replaceAll("-", "");
  const accountId = `account_ready_${suffix}`;
  const betterAuthUserId = `auth_ready_${suffix}`;
  const propertyId = `property_ready_${suffix}`;
  const caseId = `case_ready_${suffix}`;
  const pivId = `piv_ready_${suffix}`;
  const offeringId = `offering_ready_${suffix}`;
  const claimedAddress = `0x${hex}01`;
  const replacementAddress = `0x${hex}02`;
  const otherAddress = `0x${hex}03`;
  const fixedNow = new Date("2026-09-02T10:00:00.000Z");

  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const walletRepository = new PrismaWalletRepository(database);
  // PgBoss validates its connection string in the constructor, so it is built
  // in beforeAll, not at describe scope (databaseUrl is undefined when the
  // suite is skipped).
  let boss: PgBoss;
  let repository: PrismaOfferingRepository;

  const onrampAddresses: string[] = [];
  const coinbase: CoinbaseCdpClient = {
    createOnrampSessionToken: vi.fn(async (input: { walletAddress: string }) => {
      onrampAddresses.push(input.walletAddress);
      return { token: `token_${onrampAddresses.length}`, channelId: `channel_${onrampAddresses.length}` };
    }),
    buildOnrampUrl: vi.fn((input: { sessionToken: string }) => `https://pay.example.test/?t=${input.sessionToken}`),
    listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [], nextPageKey: null }),
  };

  function reservationService(): CreateReservationService {
    return new CreateReservationService(repository, repository, coinbase, {
      clock: () => fixedNow,
      fundingRailAvailable: true,
    });
  }

  let commitmentCounter = 0;
  const nextCommitment = (): string => `0x${hex}${(commitmentCounter++).toString(16).padStart(32, "0")}`;
  const claim = (walletAddress: string) =>
    walletRepository.registerWallet({
      accountId,
      walletAddress,
      registrationCommitment: nextCommitment(),
      requestedAt: new Date(),
      // A test claims, confirms and may claim again: model a fresh session.
      freshAuthentication: true,
    });
  const confirmCurrentClaim = () =>
    database.walletRegistration.update({ where: { accountId }, data: { registeredAt: new Date() } });
  const readiness = async () => (await repository.getInvestorDetail({ offeringId, accountId }))?.accountReadiness;

  async function expectBlockedByPaymentAccount(promise: Promise<unknown>): Promise<void> {
    const error = (await promise.then(
      () => null,
      (reason: unknown) => reason,
    )) as AppError | null;
    expect(error).not.toBeNull();
    expect(error).toMatchObject({ code: "offering.reservation_not_available", status: 409 });
    // The wallet must be the ONLY thing standing in the way, so the test
    // cannot pass because of some other, unrelated blocker.
    expect(error?.fieldErrors?.map((fieldError) => fieldError.code)).toEqual(["payment_account_not_ready"]);
  }

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    repository = new PrismaOfferingRepository(database, boss, new PrismaKycRepository(database, boss));
    await boss.start();
    await authPool.query(
      'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
      [betterAuthUserId, "Wallet Readiness Investor", `ready-${suffix}@example.test`, true, "customer"],
    );
    await database.account.create({
      data: {
        id: accountId,
        betterAuthUserId,
        loginMethods: {
          create: [
            { id: `login_device_${suffix}`, methodType: "device_key", providerSubject: `device_${suffix}` },
            { id: `login_google_${suffix}`, methodType: "google", providerSubject: `google_${suffix}` },
          ],
        },
        kycEligibility: {
          create: { eligibilityState: "eligible", renewalDueAt: new Date("2027-09-01T12:00:00.000Z") },
        },
      },
    });
    await database.property.create({
      data: {
        id: propertyId,
        countryCode: "DE",
        city: "Berlin",
        addressLine: "Readiness Strasse 1",
        ownerDeclaredValueEur: "600000.00",
      },
    });
    await database.intakeCase.create({
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
        legalName: "VistaBlox Readiness 01 B.V.",
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
            id: `pack_ready_${suffix}`,
            version: 1,
            publishedAt: new Date("2026-08-30T12:00:00.000Z"),
            documents: {
              create: [
                {
                  id: `document_ready_${suffix}`,
                  documentType: "ecsp_kiis",
                  documentRef: `offerings/${offeringId}/kiis-v1.pdf`,
                },
              ],
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    // Reservations and their money events are append-only and undeletable
    // (see the other offering integration suites); every id here carries a
    // per-run suffix, so leaving them behind cannot collide with a later run.
    await database.auditLog.deleteMany({ where: { resourceType: "reservation", actorAccountId: accountId } });
    await Promise.all([boss.stop(), database.$disconnect(), authPool.end()]);
  });

  it("does not treat a pending claim as a ready payment account, and never hands its address to the onramp", async () => {
    await claim(claimedAddress);

    expect(await readiness()).toMatchObject({
      walletProvisioned: false,
      walletAddress: null,
      payoutWalletRegistered: false,
    });
    await expectBlockedByPaymentAccount(
      reservationService().execute({ offeringId, accountId, amountEur: "1000.00", traceId: `trace_${suffix}` }),
    );
    expect(onrampAddresses).toEqual([]);
    expect(await database.reservation.count({ where: { accountId } })).toBe(0);
  });

  it("keeps a replaced pending claim away from the onramp, whatever address it currently holds", async () => {
    const replaced = await claim(replacementAddress);
    expect(replaced).toMatchObject({ walletAddress: replacementAddress, registeredAt: null });

    expect(await readiness()).toMatchObject({ walletProvisioned: false, walletAddress: null });
    await expectBlockedByPaymentAccount(
      reservationService().execute({
        offeringId,
        accountId,
        amountEur: "1000.00",
        clientIdempotencyKey: `operation_pending_${suffix}`,
        traceId: `trace_${suffix}`,
      }),
    );
    expect(onrampAddresses).toEqual([]);
  });

  it("refuses to mint a token for the replay of an existing reservation while the account's wallet is only pending", async () => {
    // A reservation can already exist for an account whose wallet is pending
    // (it predates the confirmed-only rule, or was written around the
    // service). Replaying its idempotency key must not hand out an onramp
    // token for whatever address the pending claim holds today.
    const replayKey = `operation_legacy_${suffix}`;
    await repository.createReservation({
      reservationId: `reservation_legacy_${suffix}`,
      offeringId,
      accountId,
      clientIdempotencyKey: replayKey,
      amountEur: "1000.00",
      disclosurePackVersionAtReservation: "1",
      traceId: `trace_${suffix}`,
      createdAt: fixedNow,
    });

    await expectBlockedByPaymentAccount(
      reservationService().execute({
        offeringId,
        accountId,
        amountEur: "1000.00",
        clientIdempotencyKey: replayKey,
        traceId: `trace_${suffix}`,
      }),
    );
    expect(onrampAddresses).toEqual([]);
  });

  it("sends the onramp to the confirmed address, and a confirmed address cannot be replaced, so a replay cannot be redirected", async () => {
    await confirmCurrentClaim();
    expect(await readiness()).toMatchObject({
      walletProvisioned: true,
      walletAddress: replacementAddress,
      payoutWalletRegistered: true,
    });

    // The replay key below belongs to the reservation the previous test wrote
    // directly; use a fresh key so this request creates its own reservation.
    const request = {
      offeringId,
      accountId,
      amountEur: "1000.00",
      clientIdempotencyKey: `operation_confirmed_${suffix}`,
      traceId: `trace_${suffix}`,
    };
    const first = await reservationService().execute(request);
    expect(onrampAddresses).toEqual([replacementAddress]);

    // Moving a CONFIRMED registration to another address is refused ...
    await expect(claim(otherAddress)).rejects.toMatchObject({
      constructor: WalletAddressConflictError,
      reason: "address_mismatch",
    });
    expect(await readiness()).toMatchObject({ walletProvisioned: true, walletAddress: replacementAddress });

    // ... so replaying the same request still delivers to the same address.
    const replay = await reservationService().execute(request);
    expect(replay.data.reservation_id).toBe(first.data.reservation_id);
    expect(onrampAddresses).toEqual([replacementAddress, replacementAddress]);
  });
});
