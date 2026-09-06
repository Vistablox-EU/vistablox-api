import { ulid } from "ulid";

import { AppError, type FieldError } from "../../../shared/errors/app-error.js";
import type { CreateReservationResponse } from "../api/offering.schemas.js";
import type { CoinbaseCdpClient } from "./coinbase-cdp-client.js";
import { subtractCurrencyFloorZero, toCents } from "../domain/currency.js";
import {
  computeReservationBlockers,
  type ReservationBlocker,
} from "../domain/reservation-eligibility.policy.js";
import type { OfferingRepository } from "../repository/offering.repository.js";
import type { ReservationRepository } from "../repository/reservation.repository.js";

const blockerMessages: Record<ReservationBlocker, string> = {
  account_restricted: "The account is not active.",
  kyc_not_eligible: "Identity verification is not currently eligible.",
  kyc_renewal_due: "Identity verification has expired and needs renewal.",
  login_methods_incomplete: "Complete Google or Apple sign-in and add a passkey before investing.",
  payment_account_not_ready: "No wallet is registered for this account.",
  disclosure_pack_unavailable: "No current disclosure pack is available for this offering.",
  offering_not_open: "This offering is not currently open for reservations.",
  capacity_exhausted: "This offering has no remaining capacity.",
  funding_rail_unavailable: "Reservation funding is not currently available.",
  recovery_cooldown_active: "This account is in a post-recovery restriction window.",
};

/**
 * Creates a capacity-holding reservation and an investor-initiated Coinbase
 * CDP onramp session in one request (AD-255, AD-146). fundingRailAvailable
 * defaults closed for the same reason GetInvestorOfferingService's does:
 * never create an unfunded capacity hold before a verified funding rail is
 * deliberately switched on.
 */
export interface CreateReservationServiceOptions {
  clock?: () => Date;
  generateReservationId?: () => string;
  fundingRailAvailable?: boolean;
  blockchain?: string;
  buildRedirectUrl?: (reservationId: string) => string;
  expiryMinutes?: number;
}

export class CreateReservationService {
  private readonly clock: () => Date;
  private readonly generateReservationId: () => string;
  private readonly fundingRailAvailable: boolean;
  private readonly blockchain: string;
  private readonly buildRedirectUrl: (reservationId: string) => string;
  private readonly expiryMinutes: number;

  public constructor(
    private readonly offerings: OfferingRepository,
    private readonly reservations: ReservationRepository,
    private readonly coinbase: CoinbaseCdpClient,
    options: CreateReservationServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.generateReservationId = options.generateReservationId ?? (() => `reservation_${ulid()}`);
    this.fundingRailAvailable = options.fundingRailAvailable ?? false;
    this.blockchain = options.blockchain ?? "base";
    this.buildRedirectUrl =
      options.buildRedirectUrl ?? ((reservationId) => `https://app.vistablox.eu/reservations/${reservationId}`);
    this.expiryMinutes = options.expiryMinutes ?? 15;
  }

  public async execute(input: {
    offeringId: string;
    accountId: string;
    amountEur: string;
    traceId: string;
  }): Promise<CreateReservationResponse> {
    const detail = await this.offerings.getInvestorDetail({
      offeringId: input.offeringId,
      accountId: input.accountId,
    });
    if (detail === null) {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }

    const now = this.clock();
    const remainingCapacityEur = subtractCurrencyFloorZero(detail.targetRaiseEur, detail.reservedCapacityEur);
    const blockers = computeReservationBlockers({
      now,
      fundingRailAvailable: this.fundingRailAvailable,
      offeringStatus: detail.status,
      finalTermsPublished: detail.finalOfferingPublishedAt !== null,
      hasDisclosurePack:
        detail.currentDisclosurePack !== null && detail.currentDisclosurePack.documents.length > 0,
      remainingCapacityEur,
      accountStatus: detail.accountReadiness.status,
      kycEligibilityState: detail.accountReadiness.kycEligibilityState,
      kycRenewalDueAt: detail.accountReadiness.kycRenewalDueAt,
      loginMethods: detail.accountReadiness.loginMethods,
      walletProvisioned: detail.accountReadiness.walletProvisioned,
      recoveryCooldownEndsAt: detail.accountReadiness.recoveryCooldownEndsAt,
    });
    if (blockers.length > 0) throw reservationNotAvailableError(blockers);

    if (toCents(input.amountEur) > toCents(remainingCapacityEur)) {
      throw amountExceedsCapacityError();
    }

    // computeReservationBlockers already required walletProvisioned; a null
    // address here would mean the read and write disagree about that.
    const walletAddress = detail.accountReadiness.walletAddress;
    if (walletAddress === null) {
      throw reservationNotAvailableError(["payment_account_not_ready"]);
    }

    const reservationId = this.generateReservationId();
    const created = await this.reservations.createReservation({
      reservationId,
      offeringId: input.offeringId,
      accountId: input.accountId,
      amountEur: input.amountEur,
      disclosurePackVersionAtReservation:
        detail.currentDisclosurePack === null ? null : String(detail.currentDisclosurePack.version),
      traceId: input.traceId,
      createdAt: now,
    });
    if (created.conflict === "offering_not_open") {
      throw reservationNotAvailableError(["offering_not_open"]);
    }
    if (created.conflict === "capacity_exceeded") {
      throw amountExceedsCapacityError();
    }
    const reservation = created.reservation;
    if (reservation === null) {
      throw new AppError({
        code: "internal.unexpected",
        title: "Internal server error",
        status: 500,
        detail: "Reservation creation returned neither a reservation nor a conflict.",
      });
    }

    let session;
    try {
      session = await this.coinbase.createOnrampSessionToken({ walletAddress, blockchain: this.blockchain });
    } catch (error) {
      await this.reservations.recordMoneyEvent({
        reservationId,
        provider: "coinbase_cdp",
        providerReference: null,
        capitalState: "purchase_failed",
        amountEur: input.amountEur,
        amountEurc: null,
        recordedAt: this.clock(),
      });
      throw error;
    }

    await this.reservations.recordMoneyEvent({
      reservationId,
      provider: "coinbase_cdp",
      providerReference: session.channelId,
      capitalState: "eurc_purchase_pending",
      amountEur: input.amountEur,
      amountEurc: null,
      recordedAt: this.clock(),
    });

    const onrampUrl = this.coinbase.buildOnrampUrl({
      sessionToken: session.token,
      partnerUserRef: reservationId,
      redirectUrl: this.buildRedirectUrl(reservationId),
    });

    return {
      data: {
        reservation_id: reservationId,
        offering_id: input.offeringId,
        amount_eur: input.amountEur,
        status: "initiated",
        expires_at: new Date(reservation.createdAt.getTime() + this.expiryMinutes * 60_000).toISOString(),
        onramp: { url: onrampUrl, channel_id: session.channelId },
      },
    };
  }
}

function reservationNotAvailableError(blockers: ReservationBlocker[]): AppError {
  const fieldErrors: FieldError[] = blockers.map((blocker) => ({
    field: "reservation",
    code: blocker,
    message: blockerMessages[blocker],
  }));
  return new AppError({
    code: "offering.reservation_not_available",
    title: "Reservation not available",
    status: 409,
    detail: "This offering is not currently available for a reservation by this account.",
    fieldErrors,
  });
}

function amountExceedsCapacityError(): AppError {
  return new AppError({
    code: "offering.reservation_amount_exceeds_capacity",
    title: "Amount exceeds remaining capacity",
    status: 422,
    detail: "The requested amount exceeds this offering's remaining capacity.",
    fieldErrors: [
      {
        field: "amount_eur",
        code: "exceeds_remaining_capacity",
        message: "The requested amount exceeds this offering's remaining capacity.",
      },
    ],
  });
}
