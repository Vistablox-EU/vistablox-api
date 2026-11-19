import { randomBytes, randomUUID } from "node:crypto";

import express, { type RequestHandler } from "express";
import { Pool } from "pg";
import { PgBoss } from "pg-boss";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import { PrismaIdempotencyStore } from "../src/infrastructure/idempotency/prisma-idempotency-store.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { createOfferingIdempotency } from "../src/modules/offering/api/offering-idempotency.js";
import { createInvestorOfferingRouter } from "../src/modules/offering/api/offering.router.js";
import { CreateReservationService } from "../src/modules/offering/application/create-reservation.service.js";
import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import { HttpCoinbaseCdpClient } from "../src/modules/offering/infrastructure/http-coinbase-cdp.client.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

// Same throwaway Ed25519 key as http-coinbase-cdp-client.test.ts: not a real Coinbase account.
const apiKeySecret =
  "MhBYvIZEwowYug+fQFKD35URQmPzSuUHQz0PEWmbWLOaRIqqYxPJmtYfF5olo7aQ1ZNOP6d36YwO4O4lhEz8pQ==";

// #57/#58: the real idempotency middleware on the real table, in front of the
// real reservation repository. The Coinbase HTTP client is real too; only its
// network call is replaced.
describe.skipIf(databaseUrl === undefined)(
  "reservation payment session through the idempotency middleware (PostgreSQL integration)",
  () => {
    const suffix = randomUUID();
    const accountId = `account_ps_${suffix}`;
    const otherAccountId = `account_ps_other_${suffix}`;
    const keyPrefix = `it-${suffix}`;
    const pool = new Pool({ connectionString: databaseUrl });
    const database = createPrismaClient(databaseUrl ?? "");
    let boss: PgBoss;
    let repository: PrismaOfferingRepository;
    let app: express.Express;

    let now = new Date("2026-11-19T10:00:00.000Z");
    let providerAnswer: "ok" | "reject" = "ok";
    let issued = 0;
    const fetch = vi.fn(async () => {
      if (providerAnswer === "reject") return new Response("sensitive upstream error", { status: 400 });
      issued += 1;
      return Response.json({ token: `token-${issued}`, channel_id: `channel-${issued}` }, { status: 201 });
    });

    async function createAccount(id: string, ready: boolean): Promise<void> {
      const betterAuthUserId = `auth_${id}`;
      await pool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [betterAuthUserId, "Payment Session Investor", `${id}@example.test`, true, "customer"],
      );
      await database.account.create({
        data: {
          id,
          betterAuthUserId,
          ...(ready
            ? {
                loginMethods: {
                  create: [
                    { id: `login_google_${id}`, methodType: "google", providerSubject: `google_${id}` },
                    { id: `login_device_${id}`, methodType: "device_key", providerSubject: `device_${id}` },
                  ],
                },
                kycEligibility: {
                  create: { eligibilityState: "eligible", renewalDueAt: new Date("2027-09-01T12:00:00.000Z") },
                },
                walletRegistration: {
                  create: {
                    walletAddress: `0x${randomBytes(20).toString("hex")}`,
                    registrationCommitment: `commitment_${id}`,
                    registeredAt: new Date("2026-08-15T12:00:00.000Z"),
                  },
                },
              }
            : {}),
        },
      });
    }

    async function createOffering(targetRaiseEur: string): Promise<string> {
      const id = randomUUID();
      const propertyId = `property_ps_${id}`;
      const caseId = `case_ps_${id}`;
      const pivId = `piv_ps_${id}`;
      const offeringId = `offering_ps_${id}`;
      await database.property.create({
        data: {
          id: propertyId,
          countryCode: "DE",
          city: "Leipzig",
          addressLine: "Payment Session Test 1",
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
          ipoEndAt: new Date("2099-12-31T00:00:00.000Z"),
        },
      });
      await database.piv.create({ data: { id: pivId, propertyId, caseId } });
      await database.offering.create({
        data: {
          id: offeringId,
          pivId,
          minimumRaiseEur: targetRaiseEur,
          targetRaiseEur,
          status: "pre_offering",
          disclosurePacks: {
            create: {
              id: `pack_ps_${id}`,
              version: 1,
              publishedAt: new Date("2026-08-30T12:00:00.000Z"),
              documents: {
                create: [
                  { id: `document_ps_${id}`, documentType: "ecsp_kiis", documentRef: `offerings/${offeringId}/kiis.pdf` },
                ],
              },
            },
          },
        },
      });
      return offeringId;
    }

    function reserve(offeringId: string, key: string, options: { amount?: string; as?: string } = {}) {
      return request(app)
        .post(`/v1/offerings/${offeringId}/reservations`)
        .set("x-test-account", options.as ?? accountId)
        .set("Idempotency-Key", `${keyPrefix}-${key}`)
        .send({ amount_eur: options.amount ?? "1000.00" });
    }

    function paymentSession(offeringId: string, reservationId: string, key: string, as?: string) {
      return request(app)
        .post(`/v1/offerings/${offeringId}/reservations/${reservationId}/payment-session`)
        .set("x-test-account", as ?? accountId)
        .set("Idempotency-Key", `${keyPrefix}-${key}`);
    }

    function sessionToken(url: string): string | null {
      return new URL(url).searchParams.get("sessionToken");
    }

    async function forgetStoredAnswer(key: string): Promise<void> {
      await database.idempotencyKey.deleteMany({ where: { idempotencyKey: `${keyPrefix}-${key}` } });
    }

    async function holdsFor(offeringId: string, clientKey: string) {
      return database.reservation.findMany({
        where: { offeringId, accountId, clientIdempotencyKey: `${keyPrefix}-${clientKey}` },
      });
    }

    async function moneyEventStates(reservationId: string): Promise<string[]> {
      const events = await database.moneyEvent.findMany({
        where: { reservationId },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        select: { capitalState: true },
      });
      return events.map((event) => event.capitalState);
    }

    beforeAll(async () => {
      boss = new PgBoss(databaseUrl ?? "");
      repository = new PrismaOfferingRepository(database, boss, new PrismaKycRepository(database, boss));
      await boss.start();
      await createAccount(accountId, true);
      await createAccount(otherAccountId, true);

      const coinbase = new HttpCoinbaseCdpClient({
        baseUrl: "https://api.developer.coinbase.com",
        payHostedUrl: "https://pay.coinbase.com/buy/select-asset",
        apiKeyId: "11111111-1111-4111-8111-111111111111",
        apiKeySecret,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      const authenticated: RequestHandler = (httpRequest, response, next) => {
        response.locals.authContext = {
          accountId: httpRequest.header("x-test-account") ?? accountId,
          providerSessionId: "session_01",
          population: "customer",
        };
        next();
      };
      app = express();
      app.use(requestContext);
      app.use(express.json());
      app.use(
        "/v1/offerings",
        createInvestorOfferingRouter(
          authenticated,
          new GetInvestorOfferingService(repository),
          undefined,
          new CreateReservationService(repository, repository, coinbase, {
            clock: () => now,
            fundingRailAvailable: true,
            buildRedirectUrl: (reservationId) => `https://app.example.test/reservations/${reservationId}`,
          }),
          undefined,
          undefined,
          createOfferingIdempotency(new PrismaIdempotencyStore(database)),
        ),
      );
      app.use(errorHandler);
    });

    afterAll(async () => {
      // money_events is append-only with a RESTRICT foreign key to
      // reservations, so reservations and everything above them stay behind;
      // every id here carries a per-run suffix. Only rows that can go are deleted.
      await database.idempotencyKey.deleteMany({ where: { idempotencyKey: { startsWith: keyPrefix } } });
      await database.auditLog.deleteMany({ where: { actorAccountId: { in: [accountId, otherAccountId] } } });
      await Promise.all([boss.stop(), database.$disconnect(), pool.end()]);
    });

    it("a repeat of the create request answers with the stored first answer; payment-session mints a new URL for the same hold", async () => {
      const offeringId = await createOffering("10000.00");

      const first = await reserve(offeringId, "k1");
      expect(first.status).toBe(201);
      const repeat = await reserve(offeringId, "k1");
      expect(repeat.status).toBe(201);
      expect(repeat.body).toEqual(first.body);

      const reservationId = first.body.data.reservation_id as string;
      const press = await paymentSession(offeringId, reservationId, "p1");
      expect(press.status).toBe(200);
      expect(press.headers["cache-control"]).toBe("no-store");
      expect(press.body.data.reservation_id).toBe(reservationId);
      expect(press.body.data.expires_at).toBe(first.body.data.expires_at);
      expect(sessionToken(press.body.data.onramp.url)).not.toBe(sessionToken(first.body.data.onramp.url));

      const nextPress = await paymentSession(offeringId, reservationId, "p2");
      expect(sessionToken(nextPress.body.data.onramp.url)).not.toBe(sessionToken(press.body.data.onramp.url));

      expect(await holdsFor(offeringId, "k1")).toHaveLength(1);
      const states = await moneyEventStates(reservationId);
      expect(states.filter((state) => state === "eurc_purchase_pending")).toHaveLength(3);
    });

    it("a lost-response retry of one payment-session press gets that press's session, not a new one", async () => {
      const offeringId = await createOffering("10000.00");
      const created = await reserve(offeringId, "k2");
      const reservationId = created.body.data.reservation_id as string;

      const press = await paymentSession(offeringId, reservationId, "p3");
      const retry = await paymentSession(offeringId, reservationId, "p3");

      expect(retry.body).toEqual(press.body);
    });

    it("a hold that took the last capacity is still resumed by its own key when no stored answer exists", async () => {
      const offeringId = await createOffering("1000.00");
      const created = await reserve(offeringId, "k3", { amount: "1000.00" });
      expect(created.status).toBe(201);
      // The first answer's save failed, or the first attempt ended in a 5xx: no row for the key.
      await forgetStoredAnswer("k3");

      const retry = await reserve(offeringId, "k3", { amount: "1000.00" });

      expect(retry.status).toBe(201);
      expect(retry.body.data.reservation_id).toBe(created.body.data.reservation_id);
      expect(sessionToken(retry.body.data.onramp.url)).not.toBe(sessionToken(created.body.data.onramp.url));
      expect(await holdsFor(offeringId, "k3")).toHaveLength(1);
    });

    it("a hold past its 15 minutes can no longer be paid through a new session or a key replay", async () => {
      const offeringId = await createOffering("10000.00");
      const created = await reserve(offeringId, "k4");
      const reservationId = created.body.data.reservation_id as string;
      const tokensBefore = issued;

      now = new Date(now.getTime() + 16 * 60_000);
      try {
        const press = await paymentSession(offeringId, reservationId, "p4");
        await forgetStoredAnswer("k4");
        const replay = await reserve(offeringId, "k4");

        expect(press.status).toBe(409);
        expect(press.body.code).toBe("offering.reservation_replay_unavailable");
        expect(replay.status).toBe(409);
        expect(replay.body.code).toBe("offering.reservation_replay_unavailable");
        expect(issued).toBe(tokensBefore);
      } finally {
        now = new Date("2026-11-19T10:00:00.000Z");
      }
    });

    it("a session is only issued while it cannot outlive the hold: served five minutes before the end, refused after", async () => {
      const offeringId = await createOffering("10000.00");
      const created = await reserve(offeringId, "k4b");
      const reservationId = created.body.data.reservation_id as string;
      const tokensBefore = issued;

      try {
        now = new Date(now.getTime() + 9 * 60_000);
        const early = await paymentSession(offeringId, reservationId, "p4b-early");
        expect(early.status).toBe(200);
        expect(issued).toBe(tokensBefore + 1);

        now = new Date(new Date("2026-11-19T10:00:00.000Z").getTime() + 11 * 60_000);
        const late = await paymentSession(offeringId, reservationId, "p4b-late");
        expect(late.status).toBe(409);
        expect(late.body.code).toBe("offering.reservation_replay_unavailable");
        expect(issued).toBe(tokensBefore + 1);
      } finally {
        now = new Date("2026-11-19T10:00:00.000Z");
      }
    });

    it("a hold the sweeper lapsed can no longer be paid through a new session", async () => {
      const offeringId = await createOffering("10000.00");
      const created = await reserve(offeringId, "k5");
      const reservationId = created.body.data.reservation_id as string;
      await repository.expireReservation({ reservationId, traceId: "req_sweep", expiredAt: now });

      const press = await paymentSession(offeringId, reservationId, "p5");

      expect(press.status).toBe(409);
      expect(press.body.code).toBe("offering.reservation_replay_unavailable");
    });

    it("a funded hold can no longer be paid through a new session or a key replay", async () => {
      const offeringId = await createOffering("10000.00");
      const created = await reserve(offeringId, "k6");
      const reservationId = created.body.data.reservation_id as string;
      await repository.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: "tx_funded",
        capitalState: "eurc_reserved",
        amountEur: "1000.00",
        amountEurc: null,
        recordedAt: new Date(now.getTime() + 1_000),
      });

      const press = await paymentSession(offeringId, reservationId, "p6");
      await forgetStoredAnswer("k6");
      const replay = await reserve(offeringId, "k6");

      expect(press.status).toBe(409);
      expect(press.body.code).toBe("offering.reservation_replay_unavailable");
      expect(replay.status).toBe(409);
      expect(replay.body.code).toBe("offering.reservation_replay_unavailable");
    });

    it("another account's hold is not found, and no session is minted for it", async () => {
      const offeringId = await createOffering("10000.00");
      const created = await reserve(offeringId, "k7");
      const reservationId = created.body.data.reservation_id as string;
      const tokensBefore = issued;

      const press = await paymentSession(offeringId, reservationId, "p7", otherAccountId);

      expect(press.status).toBe(404);
      expect(press.body.code).toBe("offering.reservation_not_found");
      expect(issued).toBe(tokensBefore);
    });

    it("the same key with another body is a 409 conflict", async () => {
      const offeringId = await createOffering("10000.00");
      await reserve(offeringId, "k8", { amount: "1000.00" });

      const conflict = await reserve(offeringId, "k8", { amount: "2000.00" });

      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe("idempotency.body_mismatch");
      expect(await holdsFor(offeringId, "k8")).toHaveLength(1);
    });

    it("the same key and body from another account, or on another offering, never gets the first reservation's answer", async () => {
      const offeringId = await createOffering("10000.00");
      const otherOfferingId = await createOffering("10000.00");
      const created = await reserve(offeringId, "k9");
      expect(created.status).toBe(201);

      const otherAccount = await reserve(offeringId, "k9", { as: otherAccountId });
      const otherOffering = await reserve(otherOfferingId, "k9");

      for (const conflict of [otherAccount, otherOffering]) {
        expect(conflict.status).toBe(409);
        expect(conflict.body.code).toBe("idempotency.body_mismatch");
        expect(JSON.stringify(conflict.body)).not.toContain(created.body.data.reservation_id);
        expect(JSON.stringify(conflict.body)).not.toContain("sessionToken");
      }
      expect(await holdsFor(otherOfferingId, "k9")).toHaveLength(0);
    });

    it("a provider rejection after the hold exists is a 5xx that is not stored; the same key then resumes the same hold", async () => {
      const offeringId = await createOffering("10000.00");
      providerAnswer = "reject";
      try {
        const rejected = await reserve(offeringId, "k10");

        expect(rejected.status).toBe(502);
        expect(rejected.body.code).toBe("offering.coinbase_provider_request_rejected");
        expect(
          await database.idempotencyKey.count({ where: { idempotencyKey: `${keyPrefix}-k10` } }),
        ).toBe(0);
        const holds = await holdsFor(offeringId, "k10");
        expect(holds).toHaveLength(1);
        expect(await moneyEventStates(holds[0]!.id)).toEqual(["initiated", "purchase_failed"]);
      } finally {
        providerAnswer = "ok";
      }

      const retry = await reserve(offeringId, "k10");

      expect(retry.status).toBe(201);
      const holds = await holdsFor(offeringId, "k10");
      expect(holds).toHaveLength(1);
      expect(retry.body.data.reservation_id).toBe(holds[0]!.id);
      expect(await moneyEventStates(holds[0]!.id)).toEqual(["initiated", "purchase_failed", "eurc_purchase_pending"]);
    });
  },
);
