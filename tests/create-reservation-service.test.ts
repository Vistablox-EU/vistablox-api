import { describe, expect, it, vi } from "vitest";

import type { CoinbaseCdpClient } from "../src/modules/offering/application/coinbase-cdp-client.js";
import { CreateReservationService } from "../src/modules/offering/application/create-reservation.service.js";
import type {
  InvestorOfferingDetailRecord,
  OfferingRepository,
} from "../src/modules/offering/repository/offering.repository.js";
import { FUNDED_CAPITAL_STATES } from "../src/modules/offering/domain/reservation-eligibility.policy.js";
import type {
  CreateReservationInput,
  CreateReservationResult,
  ReservationRepository,
  ReusedReservationState,
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
      loginMethods: ["device_key", "google"],
      kycEligibilityState: "eligible",
      kycRenewalDueAt: new Date("2027-01-01T12:00:00.000Z"),
      walletProvisioned: true,
      walletAddress,
      payoutWalletRegistered: false,
      recoveryCooldownEndsAt: null,
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
    listPendingPurchaseReservationsForTimers: vi.fn().mockResolvedValue([]),
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

// What PrismaOfferingRepository.createReservation reports on a client
// idempotency key hit: the already-persisted reservation plus its stored
// amount, stage and latest money state.
function replayedReservation(
  state: Partial<ReusedReservationState> = {},
  persisted: { reservationId?: string; createdAt?: Date } = {},
): ReservationRepository & { createReservation: ReturnType<typeof vi.fn> } {
  return reservationRepository({
    createReservation: vi.fn().mockResolvedValue({
      reservation: {
        reservationId: persisted.reservationId ?? "reservation_existing",
        createdAt: persisted.createdAt ?? now,
      },
      conflict: null,
      reused: true,
      replay: {
        amountEur: "1000.00",
        reservationStage: "initiated",
        latestCapitalState: "eurc_purchase_pending",
        ...state,
      },
    }),
  });
}

function replayService(reservations: ReservationRepository, cdp: CoinbaseCdpClient = coinbase()) {
  return new CreateReservationService(offeringRepository(detail()), reservations, cdp, {
    clock: () => now,
    generateReservationId: () => "reservation_never_persisted",
    fundingRailAvailable: true,
    buildRedirectUrl: (reservationId) => `https://app.example.test/reservations/${reservationId}`,
  });
}

const replayRequest = {
  offeringId: "offering_01",
  accountId: "account_01",
  amountEur: "1000.00",
  clientIdempotencyKey: "operation_01",
  traceId: "req_01",
};

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
      clientIdempotencyKey: null,
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
      clientIdempotencyKey: null,
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
        loginMethods: ["apple"],
        kycEligibilityState: "expired",
        kycRenewalDueAt: now,
        walletProvisioned: false,
        walletAddress: null,
        payoutWalletRegistered: false,
        recoveryCooldownEndsAt: null,
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

  describe("idempotent replay", () => {
    it("uses the persisted reservation id, not the freshly generated one, and keeps the original expiry", async () => {
      // The generated id is never saved on a replay: the repository returns
      // the already-persisted reservation instead. Everything downstream (the
      // money event's foreign key, the onramp partner ref, the redirect URL and
      // the id handed back to the client) must follow the persisted id, and the
      // expiry must follow the persisted createdAt (5 minutes before "now"),
      // not the clock.
      const persistedCreatedAt = new Date(now.getTime() - 5 * 60_000);
      const reservations = replayedReservation({}, { createdAt: persistedCreatedAt });
      const cdp = coinbase();

      const result = await replayService(reservations, cdp).execute(replayRequest);

      expect(result.data.reservation_id).toBe("reservation_existing");
      expect(result.data.amount_eur).toBe("1000.00");
      expect(result.data.expires_at).toBe(new Date(persistedCreatedAt.getTime() + 15 * 60_000).toISOString());
      expect(reservations.recordMoneyEvent).toHaveBeenCalledTimes(1);
      expect(reservations.recordMoneyEvent).toHaveBeenCalledWith(
        expect.objectContaining({ reservationId: "reservation_existing", capitalState: "eurc_purchase_pending" }),
      );
      expect(cdp.buildOnrampUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          partnerUserRef: "reservation_existing",
          redirectUrl: "https://app.example.test/reservations/reservation_existing",
        }),
      );
    });

    it.each([null, "initiated", "eurc_purchase_pending", "purchase_failed"])(
      "still serves a retry while the reservation is unfunded (latest state: %s)",
      async (latestCapitalState) => {
        const reservations = replayedReservation({ latestCapitalState });

        const result = await replayService(reservations).execute(replayRequest);

        expect(result.data.reservation_id).toBe("reservation_existing");
        expect(reservations.recordMoneyEvent).toHaveBeenCalledWith(
          expect.objectContaining({ reservationId: "reservation_existing", capitalState: "eurc_purchase_pending" }),
        );
      },
    );

    it("does not mark the reservation failed if a new onramp token cannot be issued for a retry", async () => {
      const reservations = replayedReservation();
      const failingCoinbase = coinbase({
        createOnrampSessionToken: vi.fn().mockRejectedValue(new Error("coinbase unavailable")),
      });

      await expect(replayService(reservations, failingCoinbase).execute(replayRequest)).rejects.toThrow(
        "coinbase unavailable",
      );

      expect(reservations.createReservation).toHaveBeenCalledWith(
        expect.objectContaining({ clientIdempotencyKey: "operation_01" }),
      );
      expect(reservations.recordMoneyEvent).not.toHaveBeenCalled();
    });

    // Each of these used to be masked by the replay crashing on the money
    // event's foreign key. Now that a replay can succeed they must be refused
    // before any payment session is created or any money event is written.
    it.each([
      ...FUNDED_CAPITAL_STATES.map((latestCapitalState) => ({
        label: `funded (${latestCapitalState})`,
        state: { latestCapitalState },
      })),
      { label: "lapsed", state: { reservationStage: "lapsed", latestCapitalState: "purchase_failed" } },
      { label: "cancelled", state: { reservationStage: "cancelled" } },
      { label: "awaiting reconfirmation", state: { reservationStage: "awaiting_reconfirmation" } },
    ])("refuses a retry once the reservation is $label", async ({ state }) => {
      const reservations = replayedReservation(state);
      const cdp = coinbase();

      await expect(replayService(reservations, cdp).execute(replayRequest)).rejects.toMatchObject({
        code: "offering.reservation_replay_unavailable",
        status: 409,
      });

      expect(cdp.createOnrampSessionToken).not.toHaveBeenCalled();
      expect(reservations.recordMoneyEvent).not.toHaveBeenCalled();
    });

    it("refuses a retry after the 15-minute hold has expired, even before the sweeper has lapsed it", async () => {
      const reservations = replayedReservation({}, { createdAt: new Date(now.getTime() - 15 * 60_000 - 1) });
      const cdp = coinbase();

      await expect(replayService(reservations, cdp).execute(replayRequest)).rejects.toMatchObject({
        code: "offering.reservation_replay_unavailable",
      });
      expect(cdp.createOnrampSessionToken).not.toHaveBeenCalled();
      expect(reservations.recordMoneyEvent).not.toHaveBeenCalled();
    });

    it("serves a retry made exactly at the expiry boundary, matching the sweeper's strict comparison", async () => {
      const reservations = replayedReservation({}, { createdAt: new Date(now.getTime() - 15 * 60_000) });

      await expect(replayService(reservations).execute(replayRequest)).resolves.toMatchObject({
        data: { reservation_id: "reservation_existing" },
      });
    });

    it("refuses a reused key carrying a different amount, and never records the retry's amount", async () => {
      const reservations = replayedReservation({ amountEur: "400.00" });
      const cdp = coinbase();

      await expect(replayService(reservations, cdp).execute(replayRequest)).rejects.toMatchObject({
        code: "offering.idempotency_key_reused",
        status: 409,
      });

      expect(cdp.createOnrampSessionToken).not.toHaveBeenCalled();
      expect(reservations.recordMoneyEvent).not.toHaveBeenCalled();
    });

    it("fails closed if the repository reports a key hit without the stored reservation's state", async () => {
      const reservations = reservationRepository({
        createReservation: vi.fn().mockResolvedValue({
          reservation: { reservationId: "reservation_existing", createdAt: now },
          conflict: null,
          reused: true,
        }),
      });
      const cdp = coinbase();

      await expect(replayService(reservations, cdp).execute(replayRequest)).rejects.toMatchObject({
        code: "offering.reservation_replay_unavailable",
      });
      expect(cdp.createOnrampSessionToken).not.toHaveBeenCalled();
      expect(reservations.recordMoneyEvent).not.toHaveBeenCalled();
    });
  });
});
