import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type {
  IdempotencyStore,
  StoredIdempotentResponse,
} from "../src/infrastructure/idempotency/idempotency-store.js";
import { createOfferingIdempotency } from "../src/modules/offering/api/offering-idempotency.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

function memoryStore(): IdempotencyStore {
  const rows = new Map<string, StoredIdempotentResponse>();
  return {
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

// The real mounts (endpoint identifiers and request scopes) that app.ts uses,
// each in front of a counting handler on the real route shape.
function appWithMounts() {
  const idempotency = createOfferingIdempotency(memoryStore());
  const handler = vi.fn();
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((httpRequest, response, next) => {
    response.locals.authContext = {
      accountId: httpRequest.header("x-test-account") ?? "account_01",
      providerSessionId: "session_01",
      population: "customer",
    };
    next();
  });
  const mounts: Array<[string, express.RequestHandler]> = [
    ["/v1/offerings/:offering_id/reservations", idempotency.createReservation],
    ["/v1/offerings/:offering_id/reservations/:reservation_id/reconfirm", idempotency.reconfirmReservation],
    ["/v1/offerings/:offering_id/reservations/:reservation_id/payment-session", idempotency.paymentSession],
    ["/internal/v1/offerings/:offering_id/finalize", idempotency.finalize],
  ];
  for (const [path, middleware] of mounts) {
    app.post(path, middleware, (httpRequest, response) => {
      handler(httpRequest.path);
      response.status(200).json({ answered: httpRequest.path });
    });
  }
  app.use(errorHandler);
  return { app, handler };
}

const routes = [
  {
    name: "reservation creation",
    path: (offering: string, _reservation: string) => `/v1/offerings/${offering}/reservations`,
    sendsBody: true,
  },
  {
    name: "reconfirmation",
    path: (offering: string, reservation: string) => `/v1/offerings/${offering}/reservations/${reservation}/reconfirm`,
    sendsBody: false,
  },
  {
    name: "payment session",
    path: (offering: string, reservation: string) =>
      `/v1/offerings/${offering}/reservations/${reservation}/payment-session`,
    sendsBody: false,
  },
  {
    name: "finalization",
    path: (offering: string, _reservation: string) => `/internal/v1/offerings/${offering}/finalize`,
    sendsBody: true,
  },
] as const;

describe.each(routes)("offering idempotency mount: $name", ({ path, sendsBody }) => {
  function post(app: express.Express, target: string, key: string, account = "account_01") {
    const pending = request(app).post(target).set("x-test-account", account).set("Idempotency-Key", key);
    return sendsBody ? pending.send({ amount_eur: "1000.00" }) : pending;
  }

  it("replays the stored answer to the same account on the same resource", async () => {
    const { app, handler } = appWithMounts();

    const first = await post(app, path("offering_01", "reservation_01"), "key-1");
    const repeat = await post(app, path("offering_01", "reservation_01"), "key-1");

    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual(first.body);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("answers another account under the same key with a 409, never the first account's stored answer", async () => {
    const { app, handler } = appWithMounts();

    await post(app, path("offering_01", "reservation_01"), "key-1", "account_01");
    const other = await post(app, path("offering_01", "reservation_01"), "key-1", "account_02");

    expect(other.status).toBe(409);
    expect(other.body.code).toBe("idempotency.body_mismatch");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("answers the same key on another offering with a 409", async () => {
    const { app, handler } = appWithMounts();

    await post(app, path("offering_01", "reservation_01"), "key-1");
    const other = await post(app, path("offering_02", "reservation_01"), "key-1");

    expect(other.status).toBe(409);
    expect(other.body.code).toBe("idempotency.body_mismatch");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe.each(routes.filter((route) => route.path("o", "r").includes("/reservations/")))(
  "offering idempotency mount on a reservation: $name",
  ({ path }) => {
    it("answers the same key on another reservation with a 409", async () => {
      const { app, handler } = appWithMounts();

      await request(app).post(path("offering_01", "reservation_01")).set("Idempotency-Key", "key-1");
      const other = await request(app).post(path("offering_01", "reservation_02")).set("Idempotency-Key", "key-1");

      expect(other.status).toBe(409);
      expect(other.body.code).toBe("idempotency.body_mismatch");
      expect(handler).toHaveBeenCalledTimes(1);
    });
  },
);

describe("offering idempotency endpoints", () => {
  it("keep their identifiers apart: one key on two different operations is two unrelated requests", async () => {
    const { app, handler } = appWithMounts();

    const reconfirm = await request(app)
      .post("/v1/offerings/offering_01/reservations/reservation_01/reconfirm")
      .set("Idempotency-Key", "key-1");
    const session = await request(app)
      .post("/v1/offerings/offering_01/reservations/reservation_01/payment-session")
      .set("Idempotency-Key", "key-1");

    expect(reconfirm.status).toBe(200);
    expect(session.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("offering idempotency without an authenticated account", () => {
  it("fails closed instead of letting every account share one scope", async () => {
    const idempotency = createOfferingIdempotency(memoryStore());
    const handler = vi.fn();
    const app = express();
    app.use(requestContext);
    app.post("/v1/offerings/:offering_id/reservations", idempotency.createReservation, (_request, response) => {
      handler();
      response.status(201).json({});
    });
    app.use(errorHandler);

    const response = await request(app)
      .post("/v1/offerings/offering_01/reservations")
      .set("Idempotency-Key", "key-1");

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("authentication.context_missing");
    expect(handler).not.toHaveBeenCalled();
  });
});
