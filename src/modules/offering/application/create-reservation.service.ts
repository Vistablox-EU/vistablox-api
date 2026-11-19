import { ulid } from "ulid";

import { AppError, type FieldError } from "../../../shared/errors/app-error.js";
import type { CreateReservationResponse } from "../api/offering.schemas.js";
import type { CoinbaseCdpClient } from "./coinbase-cdp-client.js";
import { subtractCurrencyFloorZero, toCents } from "../domain/currency.js";
import {
  computeReservationBlockers,
  isReservationExpired,
  isReservationFunded,
  type ReservationBlocker,
} from "../domain/reservation-eligibility.policy.js";
import type { InvestorOfferingDetailRecord, OfferingRepository } from "../repository/offering.repository.js";
import type { ReservationRepository, ReusedReservationState } from "../repository/reservation.repository.js";

const blockerMessages: Record<ReservationBlocker, string> = {
  account_restricted: "The account is not active.",
  kyc_not_eligible: "Identity verification is not currently eligible.",
  kyc_renewal_due: "Identity verification has expired and needs renewal.",
  login_methods_incomplete: "Sign in with Google or Apple and enrol this device before investing.",
  payment_account_not_ready: "No confirmed wallet is registered for this account.",
  disclosure_pack_unavailable: "No current disclosure pack is available for this offering.",
  offering_not_open: "This offering is not currently open for reservations.",
  capacity_exhausted: "This offering has no remaining capacity.",
  funding_rail_unavailable: "Reservation funding is not currently available.",
  settlement_escrow_not_ready: "Settlement for this offering is not yet available.",
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
  /**
   * How long a Coinbase session token stays valid after it is created: five
   * minutes, and single-use (Coinbase's "Create session token" reference). A
   * session is not issued for a hold that ends before the session would.
   */
  sessionLifetimeMinutes?: number;
}

export class CreateReservationService {
  private readonly clock: () => Date;
  private readonly generateReservationId: () => string;
  private readonly fundingRailAvailable: boolean;
  private readonly blockchain: string;
  private readonly buildRedirectUrl: (reservationId: string) => string;
  private readonly expiryMinutes: number;
  private readonly sessionLifetimeMinutes: number;

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
      options.buildRedirectUrl ?? ((reservationId) => `https://app.vistablox.io/reservations/${reservationId}`);
    this.expiryMinutes = options.expiryMinutes ?? 15;
    this.sessionLifetimeMinutes = options.sessionLifetimeMinutes ?? 5;
  }

  public async execute(input: {
    offeringId: string;
    accountId: string;
    amountEur: string;
    clientIdempotencyKey?: string | null;
    traceId: string;
  }): Promise<CreateReservationResponse> {
    const detail = await this.offerings.getInvestorDetail({
      offeringId: input.offeringId,
      accountId: input.accountId,
    });
    if (detail === null) throw offeringNotFoundError();

    const now = this.clock();
    // A request whose key already holds a reservation of this account is a
    // retry of that hold, not a new claim on capacity: the offering's advisory
    // capacity figures count the hold itself, so applying them would refuse
    // the retry of a request that took the last capacity (or more than what is
    // left after it). createReservation below still decides under the lock.
    const clientIdempotencyKey = input.clientIdempotencyKey ?? null;
    const resumesHold =
      clientIdempotencyKey !== null &&
      (await this.reservations.findReservationByClientKey({
        accountId: input.accountId,
        offeringId: input.offeringId,
        clientIdempotencyKey,
      })) !== null;
    const remainingCapacityEur = subtractCurrencyFloorZero(detail.targetRaiseEur, detail.reservedCapacityEur);
    const blockers = this.blockersFor(detail, now, resumesHold);
    if (blockers.length > 0) throw reservationNotAvailableError(blockers);

    if (!resumesHold && toCents(input.amountEur) > toCents(remainingCapacityEur)) {
      throw amountExceedsCapacityError();
    }

    // computeReservationBlockers already required walletProvisioned, which the
    // read model only grants for a CONFIRMED registration, and walletAddress
    // is read from that same row on every call, replays included; a null
    // address here would mean the read and write disagree about that.
    const walletAddress = detail.accountReadiness.walletAddress;
    if (walletAddress === null) {
      throw reservationNotAvailableError(["payment_account_not_ready"]);
    }

    const candidateReservationId = this.generateReservationId();
    const created = await this.reservations.createReservation({
      reservationId: candidateReservationId,
      offeringId: input.offeringId,
      accountId: input.accountId,
      clientIdempotencyKey: input.clientIdempotencyKey ?? null,
      amountEur: input.amountEur,
      disclosurePackVersionAtReservation:
        detail.currentDisclosurePack === null ? null : String(detail.currentDisclosurePack.version),
      traceId: input.traceId,
      createdAt: now,
    });
    if (created.conflict === "offering_not_open") {
      throw reservationNotAvailableError(["offering_not_open"]);
    }
    if (created.conflict === "settlement_escrow_not_ready") {
      throw reservationNotAvailableError(["settlement_escrow_not_ready"]);
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

    // On an idempotent replay the repository returns the reservation that was
    // already persisted, not the candidate id generated above (which was never
    // saved). Everything below must use the persisted id: the money event has
    // a foreign key to it, and the client is handed it back.
    const reservationId = reservation.reservationId;

    // A retry is only served while the stored reservation is still exactly
    // what the client asked for and can still be paid. Before the persisted-id
    // fix above, every replay failed on the money event's foreign key, which
    // accidentally also stopped the cases below; now that a replay can
    // succeed, they must be refused deliberately.
    if (created.reused === true) {
      this.assertReplayable({
        replay: created.replay,
        reservationCreatedAt: reservation.createdAt,
        requestedAmountEur: input.amountEur,
        now,
      });
    }

    return this.issuePaymentSession({
      reservationId,
      offeringId: input.offeringId,
      amountEur: input.amountEur,
      reservationCreatedAt: reservation.createdAt,
      walletAddress,
      // A replay must never mark an already-created reservation failed just
      // because a fresh browser-session token could not be issued.
      markFailedOnProviderError: !created.reused,
    });
  }

  /**
   * A new onramp session for a hold that already exists, for a client coming
   * back to the payment: the first answer's URL is single-use and expires
   * after five minutes, so it is never re-opened. The same rules as a retry of
   * the creating request: the hold must still be payable (stage, funding,
   * its 15 minutes), the account must still be eligible (capacity is the one
   * blocker that does not apply: the hold already holds it), and a failed
   * attempt never marks the hold failed.
   */
  public async startPaymentSession(input: {
    offeringId: string;
    reservationId: string;
    accountId: string;
  }): Promise<CreateReservationResponse> {
    // Ownership first: a reservation that is not this account's on this
    // offering is not found, whoever's it is.
    const hold = await this.reservations.findReservationForPaymentSession({
      reservationId: input.reservationId,
      offeringId: input.offeringId,
      accountId: input.accountId,
    });
    if (hold === null) throw reservationNotFoundError();
    const detail = await this.offerings.getInvestorDetail({
      offeringId: input.offeringId,
      accountId: input.accountId,
    });
    if (detail === null) throw offeringNotFoundError();

    const now = this.clock();
    this.assertPayable({
      reservationStage: hold.reservationStage,
      latestCapitalState: hold.latestCapitalState,
      reservationCreatedAt: hold.createdAt,
      now,
    });
    const blockers = this.blockersFor(detail, now, true);
    if (blockers.length > 0) throw reservationNotAvailableError(blockers);
    const walletAddress = detail.accountReadiness.walletAddress;
    if (walletAddress === null) throw reservationNotAvailableError(["payment_account_not_ready"]);

    return this.issuePaymentSession({
      reservationId: hold.reservationId,
      offeringId: hold.offeringId,
      amountEur: hold.amountEur,
      reservationCreatedAt: hold.createdAt,
      walletAddress,
      markFailedOnProviderError: false,
    });
  }

  private blockersFor(
    detail: InvestorOfferingDetailRecord,
    now: Date,
    resumesHold: boolean,
  ): ReservationBlocker[] {
    const blockers = computeReservationBlockers({
      now,
      fundingRailAvailable: this.fundingRailAvailable,
      settlementEscrow: detail.settlementEscrow,
      offeringStatus: detail.status,
      finalTermsPublished: detail.finalOfferingPublishedAt !== null,
      ipoEndAt: detail.ipoEndAt,
      hasDisclosurePack:
        detail.currentDisclosurePack !== null && detail.currentDisclosurePack.documents.length > 0,
      remainingCapacityEur: subtractCurrencyFloorZero(detail.targetRaiseEur, detail.reservedCapacityEur),
      accountStatus: detail.accountReadiness.status,
      kycEligibilityState: detail.accountReadiness.kycEligibilityState,
      kycRenewalDueAt: detail.accountReadiness.kycRenewalDueAt,
      loginMethods: detail.accountReadiness.loginMethods,
      walletProvisioned: detail.accountReadiness.walletProvisioned,
      recoveryCooldownEndsAt: detail.accountReadiness.recoveryCooldownEndsAt,
    });
    return resumesHold ? blockers.filter((blocker) => blocker !== "capacity_exhausted") : blockers;
  }

  /**
   * Asks Coinbase for a session for the hold, records the pending purchase and
   * builds the onramp URL: the tail shared by the creating request (first
   * attempt or retry) and startPaymentSession.
   */
  private async issuePaymentSession(input: {
    reservationId: string;
    offeringId: string;
    amountEur: string;
    reservationCreatedAt: Date;
    walletAddress: string;
    markFailedOnProviderError: boolean;
  }): Promise<CreateReservationResponse> {
    let session;
    try {
      session = await this.coinbase.createOnrampSessionToken({
        walletAddress: input.walletAddress,
        blockchain: this.blockchain,
      });
    } catch (error) {
      if (input.markFailedOnProviderError) {
        await this.reservations.recordMoneyEvent({
          reservationId: input.reservationId,
          provider: "coinbase_cdp",
          providerReference: null,
          capitalState: "purchase_failed",
          amountEur: input.amountEur,
          amountEurc: null,
          recordedAt: this.clock(),
        });
      }
      throw error;
    }

    // The checks before the Coinbase call ran on state read earlier; expiry or
    // a landed payment may have changed the reservation since. The repository
    // re-checks under the reservation lock, and a refused write means the
    // hold can no longer take a new payment session.
    const pendingRecorded = await this.reservations.recordMoneyEvent({
      reservationId: input.reservationId,
      provider: "coinbase_cdp",
      providerReference: session.channelId,
      capitalState: "eurc_purchase_pending",
      amountEur: input.amountEur,
      amountEurc: null,
      recordedAt: this.clock(),
    });
    if (!pendingRecorded) throw reservationReplayUnavailableError();

    const onrampUrl = this.coinbase.buildOnrampUrl({
      sessionToken: session.token,
      partnerUserRef: input.reservationId,
      redirectUrl: this.buildRedirectUrl(input.reservationId),
    });

    return {
      data: {
        reservation_id: input.reservationId,
        offering_id: input.offeringId,
        amount_eur: input.amountEur,
        status: "initiated",
        expires_at: new Date(input.reservationCreatedAt.getTime() + this.expiryMinutes * 60_000).toISOString(),
        onramp: { url: onrampUrl, channel_id: session.channelId },
      },
    };
  }

  private assertReplayable(input: {
    replay: ReusedReservationState | undefined;
    reservationCreatedAt: Date;
    requestedAmountEur: string;
    now: Date;
  }): void {
    const { replay } = input;
    // Fail closed: a key hit whose state we were not told cannot be judged safe.
    if (replay === undefined) throw reservationReplayUnavailableError();
    // AD-147: a reused key with a different body is a conflict, never a
    // silent success. The amount is the only body field the key can disagree
    // on, and recording the retry's amount against the stored hold would put
    // a figure in money_events that no reservation holds.
    if (toCents(replay.amountEur) !== toCents(input.requestedAmountEur)) {
      throw idempotencyKeyReusedError();
    }
    this.assertPayable({
      reservationStage: replay.reservationStage,
      latestCapitalState: replay.latestCapitalState,
      reservationCreatedAt: input.reservationCreatedAt,
      now: input.now,
    });
  }

  private assertPayable(input: {
    reservationStage: string;
    latestCapitalState: string | null;
    reservationCreatedAt: Date;
    now: Date;
  }): void {
    // A new session re-arms payment for the original hold; it must never
    // revive or extend one. A funded reservation would get a newer,
    // unfunded-looking money event (defeating the sweeper's funded check), and
    // a lapsed or expired one holds no capacity, so a payment through a new
    // session would never be matched to it. The same holds for a session that
    // outlives its hold: one requested at minute 13 is still payable at minute
    // 18, after the sweeper lapsed the hold at 15, and a purchase in between
    // lands as late evidence on a reservation that no longer holds anything.
    // So the last session is issued exactly one session lifetime before the
    // hold ends (ten minutes in), and a retry of the creating request obeys
    // the same limit.
    if (
      input.reservationStage !== "initiated" ||
      isReservationFunded(input.latestCapitalState) ||
      isReservationExpired({
        createdAt: input.reservationCreatedAt,
        now: input.now,
        expiryMinutes: this.expiryMinutes - this.sessionLifetimeMinutes,
      })
    ) {
      throw reservationReplayUnavailableError();
    }
  }
}

function idempotencyKeyReusedError(): AppError {
  return new AppError({
    code: "offering.idempotency_key_reused",
    title: "Idempotency key already used",
    status: 409,
    detail: "This Idempotency-Key was already used to create a reservation for a different amount.",
  });
}

function offeringNotFoundError(): AppError {
  return new AppError({
    code: "offering.not_found",
    title: "Offering not found",
    status: 404,
    detail: "The requested offering does not exist.",
  });
}

function reservationNotFoundError(): AppError {
  return new AppError({
    code: "offering.reservation_not_found",
    title: "Reservation not found",
    status: 404,
    detail: "The requested reservation does not exist.",
  });
}

function reservationReplayUnavailableError(): AppError {
  return new AppError({
    code: "offering.reservation_replay_unavailable",
    title: "Reservation can no longer be retried",
    status: 409,
    detail:
      "This reservation can no longer be paid through a new payment session. Check your reservations to see its current state.",
  });
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
