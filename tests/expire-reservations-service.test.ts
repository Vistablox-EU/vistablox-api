import { describe, expect, it, vi } from "vitest";

import { ExpireUnfundedReservationsService } from "../src/modules/offering/application/expire-reservations.service.js";
import type {
  InitiatedReservationForTimer,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

function reservation(
  overrides: Partial<InitiatedReservationForTimer> = {},
): InitiatedReservationForTimer {
  return {
    reservationId: "reservation_01",
    offeringId: "offering_01",
    accountId: "account_01",
    createdAt: new Date("2026-09-02T10:00:00.000Z"),
    ...overrides,
  };
}

function repository(overrides: Partial<ReservationRepository> = {}): ReservationRepository {
  return {
    createReservation: vi.fn(),
    recordMoneyEvent: vi.fn(),
    listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([]),
    expireReservation: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("ExpireUnfundedReservationsService", () => {
  it("expires only reservations past the 15-minute window", async () => {
    const expired = reservation({
      reservationId: "reservation_expired",
      createdAt: new Date("2026-09-02T09:44:00.000Z"),
    });
    const notYetExpired = reservation({
      reservationId: "reservation_pending",
      createdAt: new Date("2026-09-02T09:50:00.000Z"),
    });
    const expireReservation = vi.fn().mockResolvedValue(true);
    const service = new ExpireUnfundedReservationsService(
      repository({
        listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([expired, notYetExpired]),
        expireReservation,
      }),
      () => new Date("2026-09-02T10:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(expireReservation).toHaveBeenCalledTimes(1);
    expect(expireReservation).toHaveBeenCalledWith({
      reservationId: "reservation_expired",
      traceId: "req_trace_01",
      expiredAt: new Date("2026-09-02T10:00:00.000Z"),
    });
    expect(summary).toEqual({ checked: 2, acted: 1 });
  });

  it("treats exactly the boundary instant as not yet expired", async () => {
    const atBoundary = reservation({ createdAt: new Date("2026-09-02T09:45:00.000Z") });
    const expireReservation = vi.fn().mockResolvedValue(true);
    const service = new ExpireUnfundedReservationsService(
      repository({
        listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([atBoundary]),
        expireReservation,
      }),
      () => new Date("2026-09-02T10:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(expireReservation).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("does not count a reservation the repository could not expire due to a concurrent change", async () => {
    const service = new ExpireUnfundedReservationsService(
      repository({
        listInitiatedReservationsForTimers: vi
          .fn()
          .mockResolvedValue([reservation({ createdAt: new Date("2026-09-02T09:00:00.000Z") })]),
        expireReservation: vi.fn().mockResolvedValue(false),
      }),
      () => new Date("2026-09-02T10:00:00.000Z"),
    );

    const summary = await service.execute("req_trace_01");

    expect(summary).toEqual({ checked: 1, acted: 0 });
  });

  it("honors a configured expiry window other than the 15-minute default", async () => {
    const reservedFiveMinutesAgo = reservation({ createdAt: new Date("2026-09-02T09:54:00.000Z") });
    const expireReservation = vi.fn().mockResolvedValue(true);
    const service = new ExpireUnfundedReservationsService(
      repository({
        listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([reservedFiveMinutesAgo]),
        expireReservation,
      }),
      () => new Date("2026-09-02T10:00:00.000Z"),
      5,
    );

    const summary = await service.execute("req_trace_01");

    expect(expireReservation).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ checked: 1, acted: 1 });
  });
});
