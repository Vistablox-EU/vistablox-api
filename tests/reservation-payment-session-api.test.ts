import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi, type Mock } from "vitest";

import type {
  IdempotencyStore,
  StoredIdempotentResponse,
} from "../src/infrastructure/idempotency/idempotency-store.js";
import { createInvestorOfferingRouter } from "../src/modules/offering/api/offering.router.js";
import { createOfferingIdempotency } from "../src/modules/offering/api/offering-idempotency.js";
import type { CoinbaseCdpClient } from "../src/modules/offering/application/coinbase-cdp-client.js";
import { CreateReservationService } from "../src/modules/offering/application/create-reservation.service.js";
import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import { HttpCoinbaseCdpClient } from "../src/modules/offering/infrastructure/http-coinbase-cdp.client.js";
import type { OfferingRepository } from "../src/modules/offering/repository/offering.repository.js";
import type {
  CreateReservationResult,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";
import { eligibleOfferingDetail, fixtureNow } from "./support/reservation-fixtures.js";

// Same throwaway Ed25519 key as http-coinbase-cdp-client.test.ts: not a real Coinbase account.
const apiKeySecret =
  "MhBYvIZEwowYug+fQFKD35URQmPzSuUHQz0PEWmbWLOaRIqqYxPJmtYfF5olo7aQ1ZNOP6d36YwO4O4lhEz8pQ==";

function memoryStore(): IdempotencyStore & { rows: Map<string, StoredIdempotentResponse> } {
  const rows = new Map<string, StoredIdempotentResponse>();
  return {
    rows,
    find: vi.fn(async (key: string, endpoint: string) => rows.get(`${key}:${endpoint}`) ?? null),
    save: vi.fn(async (input) => {
      const row = {
        requestBodyHash: input.requestBodyHash,
        responseStatus: input.responseStatus,
        responseBody: input.responseBody,
      };
      rows.set(`${input.idempotencyKey}:${input.endpoint}`, row);
      return row;
    }),
  };
}

function sequencedCoinbase(): CoinbaseCdpClient & { createOnrampSessionToken: ReturnType<typeof vi.fn> } {
  let sequence = 0;
  return {
    createOnrampSessionToken: vi.fn(async () => {
      sequence += 1;
      return { token: `token-${sequence}`, channelId: `channel-${sequence}` };
    }),
    buildOnrampUrl: vi.fn(
      (input: { sessionToken: string; partnerUserRef: string }) =>
        `https://pay.coinbase.com/buy/select-asset?sessionToken=${input.sessionToken}&partnerUserRef=${input.partnerUserRef}`,
    ),
    listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [], nextPageKey: null }),
  };
}

const hold = {
  reservationId: "reservation_existing",
  offeringId: "offering_01",
  accountId: "account_01",
  amountEur: "1000.00",
  createdAt: fixtureNow,
  reservationStage: "initiated",
  latestCapitalState: "eurc_purchase_pending",
};

function buildApp(options: {
  store?: ReturnType<typeof memoryStore>;
  coinbase?: CoinbaseCdpClient;
  reservations?: Partial<ReservationRepository>;
  population?: "customer" | "staff_partner";
}) {
  const store = options.store ?? memoryStore();
  const offerings: OfferingRepository = {
    listPublic: vi.fn().mockResolvedValue([]),
    getInvestorDetail: vi.fn().mockResolvedValue(eligibleOfferingDetail()),
  };
  const reservations = {
    createReservation: vi.fn(async (input): Promise<CreateReservationResult> => ({
      reservation: { reservationId: input.reservationId, createdAt: input.createdAt },
      conflict: null,
      reused: false,
    })),
    recordMoneyEvent: vi.fn().mockResolvedValue(true),
    listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([]),
    expireReservation: vi.fn().mockResolvedValue(false),
    listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([]),
    findReservationForOnrampReconciliation: vi.fn().mockResolvedValue(null),
    recordOnrampOutcome: vi.fn().mockResolvedValue({ status: "unknown_reservation" }),
    findReservationByClientKey: vi.fn().mockResolvedValue(null),
    findReservationForPaymentSession: vi.fn().mockResolvedValue(hold),
    ...options.reservations,
  } as unknown as ReservationRepository & {
    createReservation: Mock;
    recordMoneyEvent: Mock;
    findReservationByClientKey: Mock;
    findReservationForPaymentSession: Mock;
  };
  const coinbase = options.coinbase ?? sequencedCoinbase();
  const authenticated: RequestHandler = (httpRequest, response, next) => {
    response.locals.authContext = {
      accountId: httpRequest.header("x-test-account") ?? "account_01",
      providerSessionId: "session_01",
      population: options.population ?? "customer",
    };
    next();
  };
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use(
    "/v1/offerings",
    createInvestorOfferingRouter(
      authenticated,
      new GetInvestorOfferingService(offerings),
      undefined,
      new CreateReservationService(offerings, reservations, coinbase, {
        clock: () => fixtureNow,
        generateReservationId: () => "reservation_01",
        fundingRailAvailable: true,
      }),
      undefined,
      undefined,
      createOfferingIdempotency(store),
    ),
  );
  app.use(errorHandler);
  return { app, store, reservations, coinbase };
}

const paymentSessionPath = "/v1/offerings/offering_01/reservations/reservation_existing/payment-session";

describe("POST /v1/offerings/:offering_id/reservations/:reservation_id/payment-session", () => {
  it("requires an Idempotency-Key", async () => {
    const { app, reservations } = buildApp({});

    const response = await request(app).post(paymentSessionPath);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("idempotency.key_required");
    expect(reservations.findReservationForPaymentSession).not.toHaveBeenCalled();
  });

  it("returns a fresh session for the existing hold, uncached", async () => {
    const { app, reservations } = buildApp({});

    const response = await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-1");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      data: {
        reservation_id: "reservation_existing",
        offering_id: "offering_01",
        amount_eur: "1000.00",
        status: "initiated",
        expires_at: "2026-09-02T10:15:00.000Z",
        onramp: {
          url: "https://pay.coinbase.com/buy/select-asset?sessionToken=token-1&partnerUserRef=reservation_existing",
          channel_id: "channel-1",
        },
      },
    });
    expect(reservations.findReservationForPaymentSession).toHaveBeenCalledWith({
      reservationId: "reservation_existing",
      offeringId: "offering_01",
      accountId: "account_01",
    });
    expect(reservations.createReservation).not.toHaveBeenCalled();
  });

  it("gives each press (a new key) its own session, and a lost-response retry of one press the same one", async () => {
    const { app, coinbase } = buildApp({});

    const firstPress = await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-1");
    const retryOfFirstPress = await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-1");
    const secondPress = await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-2");

    expect(firstPress.body.data.onramp.url).toContain("sessionToken=token-1");
    expect(retryOfFirstPress.body).toEqual(firstPress.body);
    expect(secondPress.body.data.onramp.url).toContain("sessionToken=token-2");
    expect(coinbase.createOnrampSessionToken).toHaveBeenCalledTimes(2);
  });

  it("answers another account's use of the same key with a 409, not with the first account's session", async () => {
    const { app, coinbase } = buildApp({});

    await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-1");
    const other = await request(app)
      .post(paymentSessionPath)
      .set("x-test-account", "account_02")
      .set("Idempotency-Key", "press-1");

    expect(other.status).toBe(409);
    expect(other.body.code).toBe("idempotency.body_mismatch");
    expect(JSON.stringify(other.body)).not.toContain("sessionToken");
    expect(coinbase.createOnrampSessionToken).toHaveBeenCalledTimes(1);
  });

  it("is customer-only", async () => {
    const { app, coinbase } = buildApp({ population: "staff_partner" });

    const response = await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-1");

    expect(response.status).toBe(403);
    expect(coinbase.createOnrampSessionToken).not.toHaveBeenCalled();
  });

  it("answers 404 for a reservation that is not this account's", async () => {
    const { app } = buildApp({ reservations: { findReservationForPaymentSession: vi.fn().mockResolvedValue(null) } });

    const response = await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-1");

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("offering.reservation_not_found");
  });

  it("answers 409 offering.reservation_replay_unavailable once the hold lapsed", async () => {
    const { app } = buildApp({
      reservations: {
        findReservationForPaymentSession: vi.fn().mockResolvedValue({ ...hold, reservationStage: "lapsed" }),
      },
    });

    const response = await request(app).post(paymentSessionPath).set("Idempotency-Key", "press-1");

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("offering.reservation_replay_unavailable");
  });
});

describe("POST /v1/offerings/:offering_id/reservations after the hold exists (#58)", () => {
  function rejectingThenAcceptingCoinbase() {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("sensitive upstream error", { status: 400 }))
      .mockResolvedValue(Response.json({ token: "token-ok", channel_id: "channel-ok" }, { status: 201 }));
    const client = new HttpCoinbaseCdpClient({
      baseUrl: "https://api.developer.coinbase.com",
      payHostedUrl: "https://pay.coinbase.com/buy/select-asset",
      apiKeyId: "11111111-1111-4111-8111-111111111111",
      apiKeySecret,
      fetch,
    });
    return { client, fetch };
  }

  it("answers a provider rejection with a 5xx that is not stored, and a same-key retry resumes the same hold", async () => {
    const { client } = rejectingThenAcceptingCoinbase();
    const createReservation = vi
      .fn()
      .mockResolvedValueOnce({
        reservation: { reservationId: "reservation_01", createdAt: fixtureNow },
        conflict: null,
        reused: false,
      })
      .mockResolvedValueOnce({
        reservation: { reservationId: "reservation_01", createdAt: fixtureNow },
        conflict: null,
        reused: true,
        replay: { amountEur: "1000.00", reservationStage: "initiated", latestCapitalState: "purchase_failed" },
      });
    const { app, store, reservations } = buildApp({
      coinbase: client,
      reservations: {
        createReservation,
        findReservationByClientKey: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ reservationId: "reservation_01" }),
      },
    });

    const rejected = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .set("Idempotency-Key", "reserve-1")
      .send({ amount_eur: "1000.00" });

    expect(rejected.status).toBe(502);
    expect(rejected.body.code).toBe("offering.coinbase_provider_request_rejected");
    expect(store.rows.size).toBe(0);
    expect(reservations.recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_01", capitalState: "purchase_failed" }),
    );

    const retry = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .set("Idempotency-Key", "reserve-1")
      .send({ amount_eur: "1000.00" });

    expect(retry.status).toBe(201);
    expect(retry.body.data.reservation_id).toBe("reservation_01");
    expect(retry.body.data.onramp.url).toContain("sessionToken=token-ok");
    expect(createReservation).toHaveBeenCalledTimes(2);
    // Only the first attempt marks a hold failed.
    expect(
      reservations.recordMoneyEvent.mock.calls.filter(
        ([event]) => (event as { capitalState: string }).capitalState === "purchase_failed",
      ),
    ).toHaveLength(1);
  });

  it("answers the same key on another offering with a 409, not with the first offering's reservation", async () => {
    const { app, reservations } = buildApp({});

    await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .set("Idempotency-Key", "reserve-1")
      .send({ amount_eur: "1000.00" });
    const other = await request(app)
      .post("/v1/offerings/offering_02/reservations")
      .set("Idempotency-Key", "reserve-1")
      .send({ amount_eur: "1000.00" });

    expect(other.status).toBe(409);
    expect(other.body.code).toBe("idempotency.body_mismatch");
    expect(reservations.createReservation).toHaveBeenCalledTimes(1);
  });

  it("answers another account's same key and body with a 409, not with the first account's reservation and URL", async () => {
    const { app, reservations } = buildApp({});

    await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .set("Idempotency-Key", "reserve-1")
      .send({ amount_eur: "1000.00" });
    const other = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .set("x-test-account", "account_02")
      .set("Idempotency-Key", "reserve-1")
      .send({ amount_eur: "1000.00" });

    expect(other.status).toBe(409);
    expect(other.body.code).toBe("idempotency.body_mismatch");
    expect(JSON.stringify(other.body)).not.toContain("sessionToken");
    expect(reservations.createReservation).toHaveBeenCalledTimes(1);
  });

  it("answers a response that fails its schema as a 500, not a 422 the client would treat as final, and does not store it", async () => {
    const coinbase = sequencedCoinbase();
    coinbase.buildOnrampUrl = vi.fn(() => "not a url");
    const { app, store } = buildApp({ coinbase });

    const response = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .set("Idempotency-Key", "reserve-1")
      .send({ amount_eur: "1000.00" });

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("internal.response_invalid");
    expect(store.rows.size).toBe(0);
  });
});
