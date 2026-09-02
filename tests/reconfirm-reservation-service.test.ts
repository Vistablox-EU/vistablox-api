import { describe, expect, it, vi } from "vitest";

import { ReconfirmReservationService } from "../src/modules/offering/application/reconfirm-reservation.service.js";
import type {
  FinalizeOfferingRepository,
  ReconfirmReservationInput,
  ReconfirmReservationResult,
} from "../src/modules/offering/repository/finalize-offering.repository.js";

const now = new Date("2026-09-05T12:00:00.000Z");

function repository(overrides: Partial<FinalizeOfferingRepository> = {}): FinalizeOfferingRepository {
  return {
    publishFinalOfferingTerms: vi.fn(),
    reconfirmReservation: vi.fn(
      async (input: ReconfirmReservationInput): Promise<ReconfirmReservationResult> => ({
        reconfirmedAt: input.reconfirmedAt,
        conflict: null,
      }),
    ),
    listOfferingsPendingFinalizationCommit: vi.fn().mockResolvedValue([]),
    commitOfferingFinalization: vi.fn(),
    ...overrides,
  };
}

describe("ReconfirmReservationService", () => {
  it("reconfirms a reservation awaiting reconfirmation and reports the outcome", async () => {
    const reconfirmReservation = vi.fn().mockResolvedValue({ reconfirmedAt: now, conflict: null });
    const service = new ReconfirmReservationService(repository({ reconfirmReservation }), () => now);

    const result = await service.execute({
      accountId: "account_investor",
      reservationId: "reservation_01",
      traceId: "req_01",
    });

    expect(result).toEqual({
      data: {
        reservation_id: "reservation_01",
        status: "reconfirmed",
        reconfirmed_at: now.toISOString(),
      },
    });
    expect(reconfirmReservation).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      accountId: "account_investor",
      traceId: "req_01",
      reconfirmedAt: now,
    });
  });

  // Covers both a nonexistent reservation and one owned by a different
  // account — the repository deliberately returns the same conflict for
  // both, so as not to leak whether a reservation_id exists to someone who
  // doesn't own it.
  it("404s when the reservation does not exist or is not owned by the caller", async () => {
    const service = new ReconfirmReservationService(
      repository({
        reconfirmReservation: vi.fn().mockResolvedValue({ reconfirmedAt: null, conflict: "not_found" }),
      }),
      () => now,
    );

    await expect(
      service.execute({ accountId: "account_investor", reservationId: "reservation_missing", traceId: "req_01" }),
    ).rejects.toMatchObject({ code: "offering.reservation_not_found", status: 404 });
  });

  it("409s when the reservation is not currently awaiting reconfirmation", async () => {
    const service = new ReconfirmReservationService(
      repository({
        reconfirmReservation: vi
          .fn()
          .mockResolvedValue({ reconfirmedAt: null, conflict: "not_awaiting_reconfirmation" }),
      }),
      () => now,
    );

    await expect(
      service.execute({ accountId: "account_investor", reservationId: "reservation_01", traceId: "req_01" }),
    ).rejects.toMatchObject({ code: "offering.reservation_not_awaiting_reconfirmation", status: 409 });
  });

  it("409s once the reconfirmation window has closed", async () => {
    const service = new ReconfirmReservationService(
      repository({
        reconfirmReservation: vi.fn().mockResolvedValue({ reconfirmedAt: null, conflict: "window_closed" }),
      }),
      () => now,
    );

    await expect(
      service.execute({ accountId: "account_investor", reservationId: "reservation_01", traceId: "req_01" }),
    ).rejects.toMatchObject({ code: "offering.reconfirmation_window_closed", status: 409 });
  });
});
