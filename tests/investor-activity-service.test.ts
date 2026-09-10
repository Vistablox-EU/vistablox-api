import { describe, expect, it, vi } from "vitest";

import {
  decodePositionCursor,
  decodeReservationCursor,
  ListInvestorCurrentPositionsService,
  ListInvestorReservationsService,
} from "../src/modules/investor-activity/application/list-investor-activity.service.js";
import type {
  InvestorActivityRepository,
  InvestorPositionRecord,
  InvestorReservationRecord,
} from "../src/modules/investor-activity/repository/investor-activity.repository.js";

function repository(
  overrides: Partial<InvestorActivityRepository> = {},
): InvestorActivityRepository {
  return {
    listReservations: vi.fn().mockResolvedValue([]),
    listCurrentPositions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function reservation(
  id: string,
  createdAt: Date,
): InvestorReservationRecord {
  return {
    reservationId: id,
    offeringId: "off_01",
    offeringStatus: "pre_offering",
    amountEur: "2500.00",
    reservationStage: "reconfirmed",
    disclosurePackVersionAtReservation: "3",
    reconfirmedAt: new Date("2026-08-31T12:00:00.000Z"),
    reservationFinalizedAt: null,
    createdAt,
    latestMoneyEvent: {
      capitalState: "reconfirmation_pending",
      amountEur: "2500.00",
      amountEurc: "2498.500000",
      recordedAt: new Date("2026-09-01T09:00:00.000Z"),
    },
    property: { propertyType: "residential", countryCode: "DE", city: "Berlin" },
  };
}

function position(
  id: string,
  activatedAt: Date | null,
): InvestorPositionRecord {
  return {
    positionId: id,
    reservationId: "res_01",
    offeringId: "off_01",
    pivId: "piv_01",
    unitCount: "12.500000",
    costBasisEur: "2500.00",
    positionStatus: activatedAt === null ? "pending_internal_settlement" : "active",
    activatedAt,
    property: { propertyType: "residential", countryCode: "DE", city: "Berlin" },
  };
}

describe("investor activity services", () => {
  it("returns bounded reservation history with an opaque next cursor", async () => {
    const rows = [
      reservation("res_03", new Date("2026-09-03T12:00:00.000Z")),
      reservation("res_02", new Date("2026-09-02T12:00:00.000Z")),
      reservation("res_01", new Date("2026-09-01T12:00:00.000Z")),
    ];
    const storage = repository({ listReservations: vi.fn().mockResolvedValue(rows) });

    const result = await new ListInvestorReservationsService(storage).execute({
      accountId: "acct_01",
      query: { limit: 2 },
    });

    expect(storage.listReservations).toHaveBeenCalledWith({
      accountId: "acct_01",
      limit: 3,
    });
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      reservation_id: "res_03",
      latest_capital_state: {
        state: "reconfirmation_pending",
        amount_eurc: "2498.500000",
      },
      property: { country_code: "DE", city: "Berlin" },
    });
    expect(decodeReservationCursor(result.page.next_cursor!)).toEqual({
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
      id: "res_02",
    });
  });

  it("paginates active and pending positions without exposing wallet data", async () => {
    const rows = [
      position("pos_02", new Date("2026-09-02T12:00:00.000Z")),
      position("pos_01", null),
    ];
    const storage = repository({
      listCurrentPositions: vi.fn().mockResolvedValue(rows),
    });

    const result = await new ListInvestorCurrentPositionsService(storage).execute({
      accountId: "acct_01",
      query: { limit: 1 },
    });

    expect(result.data).toEqual([
      {
        position_id: "pos_02",
        reservation_id: "res_01",
        offering_id: "off_01",
        piv_id: "piv_01",
        unit_count: "12.500000",
        cost_basis_eur: "2500.00",
        position_status: "active",
        activated_at: "2026-09-02T12:00:00.000Z",
        property: {
          property_type: "residential",
          country_code: "DE",
          city: "Berlin",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("wallet");
    expect(decodePositionCursor(result.page.next_cursor!)).toEqual({
      activatedAt: new Date("2026-09-02T12:00:00.000Z"),
      id: "pos_02",
    });
  });

  it("rejects malformed and cross-endpoint cursors", async () => {
    const reservations = new ListInvestorReservationsService(repository());
    const positionCursor = Buffer.from(
      JSON.stringify({
        kind: "investor_positions",
        activated_at: null,
        id: "pos_01",
      }),
      "utf8",
    ).toString("base64url");

    await expect(
      reservations.execute({
        accountId: "acct_01",
        query: { limit: 20, after: positionCursor },
      }),
    ).rejects.toMatchObject({ code: "pagination.invalid_cursor", status: 422 });
  });
});
