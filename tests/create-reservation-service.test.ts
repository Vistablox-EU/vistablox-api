import { describe, expect, it, vi } from "vitest";

import type { CoinbaseCdpClient } from "../src/modules/offering/application/coinbase-cdp-client.js";
import { CreateReservationService } from "../src/modules/offering/application/create-reservation.service.js";
import type {
  InvestorOfferingDetailRecord,
  OfferingRepository,
} from "../src/modules/offering/repository/offering.repository.js";
import type {
  CreateReservationInput,
  CreateReservationResult,
  ReservationRepository,
} from "../src/modules/offering/repository/reservation.repository.js";

const now = new Date("2026-09-02T10:00:00.000Z");
const walletAddress = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

function detail(overrides: Partial<InvestorOfferingDetailRecord> = {}): InvestorOfferingDetailRecord {
  return {
    id: "offering_01",
    status: "pre_offering",
    minimumRaiseEur: "250000.00",
    targetRaiseEur: "500000.00",
    finalOfferingPublishedAt: null,
    platformRightsEndAt: null,
    effectiveRightsEndAt: null,
    ipoEndAt: new Date("2026-10-01T12:00:00.000Z"),
    issuer: {
      pivId: "piv_01",
      legalName: "VistaBlox Berlin 01 B.V.",
      jurisdiction: "NL",
      registrationNumber: "12345678",
      structurePattern: "default_aligned",
      incorporatedAt: new Date("2026-08-01T12:00:00.000Z"),
    },
    property: {
      propertyId: "property_01",
      propertyType: "residential",
      countryCode: "DE",
      city: "Berlin",
      addressLine: "Example Strasse 1",
      ownerDeclaredValueEur: "600000.00",
      appraisalValueOpinionEur: "625000.00",
    },
    currentDisclosurePack: {
      id: "pack_01",
      version: 2,
      publishedAt: new Date("2026-08-30T12:00:00.000Z"),
      documents: [
        { id: "document_01", documentType: "ecsp_kiis", documentRef: "documents/kiis-v2.pdf", isCoreReading: true },
      ],
    },
    materialityRecords: [],
    reservedCapacityEur: "125000.00",
    fundedEur: "100000.00",
    accountReadiness: {
      status: "active",
      loginMethods: ["google", "email_password"],
      kycEligibilityState: "eligible",
      kycRenewalDueAt: new Date("2027-01-01T12:00:00.000Z"),
      walletProvisioned: true,
      walletAddress,
      payoutWalletRegistered: false,
    },
    ...overrides,
  };
}

function offeringRepository(record: InvestorOfferingDetailRecord | null): OfferingRepository {
  return {
    listPublic: vi.fn().mockResolvedValue([]),
    getInvestorDetail: vi.fn().mockResolvedValue(record),
  };
}

function reservationRepository(
  overrides: Partial<ReservationRepository> = {},
): ReservationRepository & { createReservation: ReturnType<typeof vi.fn> } {
  const createReservation = vi.fn(
    async (input: CreateReservationInput): Promise<CreateReservationResult> => ({
      reservation: { reservationId: input.reservationId, createdAt: input.createdAt },
      conflict: null,
    }),
  );
  return {
    createReservation,
    recordMoneyEvent: vi.fn().mockResolvedValue(undefined),
    listInitiatedReservationsForTimers: vi.fn().mockResolvedValue([]),
    expireReservation: vi.fn().mockResolvedValue(false),
    ...overrides,
  } as ReservationRepository & { createReservation: ReturnType<typeof vi.fn> };
}

function coinbase(overrides: Partial<CoinbaseCdpClient> = {}): CoinbaseCdpClient {
  return {
    createOnrampSessionToken: vi.fn().mockResolvedValue({ token: "session-token-01", channelId: "channel-01" }),
    buildOnrampUrl: vi.fn(
      (input: { sessionToken: string; partnerUserRef: string; redirectUrl: string }) =>
        `https://pay.coinbase.com/buy/select-asset?sessionToken=${input.sessionToken}&partnerUserRef=${input.partnerUserRef}`,
    ),
    listBuyTransactions: vi.fn().mockResolvedValue({ transactions: [], nextPageKey: null }),
    ...overrides,
  };
}

describe("CreateReservationService", () => {
  it("creates a reservation and an onramp session when the funding rail is enabled", async () => {
    const reservations = reservationRepository();
    const cdp = coinbase();
    const service = new CreateReservationService(
      offeringRepository(detail()),
      reservations,
      cdp,
      { clock: () => now, generateReservationId: () => "reservation_01", fundingRailAvailable: true },
    );

    const result = await service.execute({
      offeringId: "offering_01",
      accountId: "account_01",
      amountEur: "1000.00",
      traceId: "req_01",
    });

    expect(result).toEqual({
      data: {
        reservation_id: "reservation_01",
        offering_id: "offering_01",
        amount_eur: "1000.00",
        status: "initiated",
        expires_at: "2026-09-02T10:15:00.000Z",
        onramp: {
          url: "https://pay.coinbase.com/buy/select-asset?sessionToken=session-token-01&partnerUserRef=reservation_01",
          channel_id: "channel-01",
        },
      },
    });
    expect(reservations.createReservation).toHaveBeenCalledWith({
      reservationId: "reservation_01",
      offeringId: "offering_01",
      accountId: "account_01",
      amountEur: "1000.00",
      disclosurePackVersionAtReservation: "2",
      traceId: "req_01",
      createdAt: now,
    });
    expect(cdp.createOnrampSessionToken).toHaveBeenCalledWith({ walletAddress, blockchain: "base" });
    expect(reservations.recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_01", capitalState: "eurc_purchase_pending" }),
    );
  });

  it("404s when the offering does not exist", async () => {
    const service = new CreateReservationService(offeringRepository(null), reservationRepository(), coinbase());

    await expect(
      service.execute({ offeringId: "offering_01", accountId: "account_01", amountEur: "1000.00", traceId: "req_01" }),
    ).rejects.toMatchObject({ code: "offering.not_found", status: 404 });
  });

  it("keeps the funding rail closed by default, blocking every reservation attempt", async () => {
    const service = new CreateReservationService(offeringRepository(detail()), reservationRepository(), coinbase());

    await expect(
      service.execute({ offeringId: "offering_01", accountId: "account_01", amountEur: "1000.00", traceId: "req_01" }),
    ).rejects.toMatchObject({
      code: "offering.reservation_not_available",
      status: 409,
      fieldErrors: [{ field: "reservation", code: "funding_rail_unavailable" }],
    });
  });

  it("reports every current blocker together, not just the first", async () => {
    const record = detail({
      accountReadiness: {
        status: "active",
        loginMethods: ["email_password"],
        kycEligibilityState: "expired",
        kycRenewalDueAt: now,
        walletProvisioned: false,
        walletAddress: null,
        payoutWalletRegistered: false,
      },
    });
    const service = new CreateReservationService(offeringRepository(record), reservationRepository(), coinbase(), {
      clock: () => now,
      fundingRailAvailable: true,
    });

    await expect(
      service.execute({ offeringId: "offering_01", accountId: "account_01", amountEur: "1000.00", traceId: "req_01" }),
    ).rejects.toMatchObject({
      code: "offering.reservation_not_available",
      fieldErrors: [
        { field: "reservation", code: "kyc_not_eligible" },
        { field: "reservation", code: "login_methods_incomplete" },
        { field: "reservation", code: "payment_account_not_ready" },
      ],
    });
  });

  it("rejects an amount larger than the advisory remaining capacity before writing anything", async () => {
    const reservations = reservationRepository();
    const service = new CreateReservationService(offeringRepository(detail()), reservations, coinbase(), {
      clock: () => now,
      fundingRailAvailable: true,
    });

    await expect(
      service.execute({ offeringId: "offering_01", accountId: "account_01", amountEur: "999999.00", traceId: "req_01" }),
    ).rejects.toMatchObject({
      code: "offering.reservation_amount_exceeds_capacity",
      status: 422,
      fieldErrors: [{ field: "amount_eur", code: "exceeds_remaining_capacity" }],
    });
    expect(reservations.createReservation).not.toHaveBeenCalled();
  });

  it("maps an atomic capacity_exceeded conflict from the repository to the same 422", async () => {
    const reservations = reservationRepository({
      createReservation: vi.fn().mockResolvedValue({ reservation: null, conflict: "capacity_exceeded" }),
    });
    const service = new CreateReservationService(offeringRepository(detail()), reservations, coinbase(), {
      clock: () => now,
      fundingRailAvailable: true,
    });

    await expect(
      service.execute({ offeringId: "offering_01", accountId: "account_01", amountEur: "1000.00", traceId: "req_01" }),
    ).rejects.toMatchObject({ code: "offering.reservation_amount_exceeds_capacity", status: 422 });
  });

  it("maps an atomic offering_not_open conflict from the repository to a 409", async () => {
    const reservations = reservationRepository({
      createReservation: vi.fn().mockResolvedValue({ reservation: null, conflict: "offering_not_open" }),
    });
    const service = new CreateReservationService(offeringRepository(detail()), reservations, coinbase(), {
      clock: () => now,
      fundingRailAvailable: true,
    });

    await expect(
      service.execute({ offeringId: "offering_01", accountId: "account_01", amountEur: "1000.00", traceId: "req_01" }),
    ).rejects.toMatchObject({
      code: "offering.reservation_not_available",
      status: 409,
      fieldErrors: [{ field: "reservation", code: "offering_not_open" }],
    });
  });

  it("records a purchase_failed money event and rethrows when Coinbase session creation fails", async () => {
    const reservations = reservationRepository();
    const failingCoinbase = coinbase({
      createOnrampSessionToken: vi.fn().mockRejectedValue(new Error("coinbase unavailable")),
    });
    const service = new CreateReservationService(offeringRepository(detail()), reservations, failingCoinbase, {
      clock: () => now,
      generateReservationId: () => "reservation_01",
      fundingRailAvailable: true,
    });

    await expect(
      service.execute({ offeringId: "offering_01", accountId: "account_01", amountEur: "1000.00", traceId: "req_01" }),
    ).rejects.toThrow("coinbase unavailable");

    expect(reservations.recordMoneyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ reservationId: "reservation_01", capitalState: "purchase_failed" }),
    );
  });
});
