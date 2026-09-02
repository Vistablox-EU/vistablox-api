import { ulid } from "ulid";

import { toCents } from "../domain/currency.js";
import { publicOfferingStatuses, isPublicOfferingStatus } from "../domain/public-offering.policy.js";
import type {
  InvestorOfferingDetailRecord,
  ListPublicOfferingsInput,
  OfferingRepository,
  PublicOfferingRecord,
} from "./offering.repository.js";
import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type {
  AccessibleDisclosureDocumentRecord,
  DisclosureDocumentRepository,
} from "./disclosure-document.repository.js";
import type {
  OfferingOriginationHandoffRepository,
  OpenedOffering,
  OpenOfferingForApprovedCaseInput,
} from "./offering-origination-handoff.repository.js";
import type {
  AdvanceReservationCapitalStateInput,
  CreateReservationInput,
  CreateReservationResult,
  ExpireReservationInput,
  InitiatedReservationForTimer,
  PendingPurchaseReservationForTimer,
  ReservationRepository,
} from "./reservation.repository.js";
import { FUNDED_CAPITAL_STATES } from "../domain/reservation-eligibility.policy.js";
import {
  canPublishFinalOfferingTerms,
  computeEffectiveRightsEndAt,
  costBasisToUnitCount,
  isReconfirmationWindowOpen,
} from "../domain/finalization.policy.js";
import type {
  CommitOfferingFinalizationInput,
  CommitOfferingFinalizationResult,
  FinalizeOfferingRepository,
  OfferingPendingFinalizationCommit,
  PublishFinalOfferingTermsInput,
  PublishFinalOfferingTermsResult,
  ReconfirmReservationInput,
  ReconfirmReservationResult,
} from "./finalize-offering.repository.js";

export class PrismaOfferingRepository
  implements
    OfferingRepository,
    DisclosureDocumentRepository,
    OfferingOriginationHandoffRepository,
    FinalizeOfferingRepository,
    ReservationRepository
{
  public constructor(private readonly database: DatabaseClient) {}

  public async openOfferingForApprovedCase(
    input: OpenOfferingForApprovedCaseInput,
  ): Promise<OpenedOffering> {
    return this.database.$transaction(async (transaction) => {
      const existingPiv = await transaction.piv.findUnique({
        where: { propertyId: input.propertyId },
        select: { id: true, offerings: { select: { id: true }, take: 1 } },
      });
      if (existingPiv !== null) {
        const existingOffering = existingPiv.offerings[0];
        if (existingOffering !== undefined) {
          return { pivId: existingPiv.id, offeringId: existingOffering.id };
        }
        const offering = await transaction.offering.create({
          data: {
            id: `offering_${ulid()}`,
            pivId: existingPiv.id,
            minimumRaiseEur: input.ipoValueEur,
            targetRaiseEur: input.ipoValueEur,
          },
          select: { id: true },
        });
        return { pivId: existingPiv.id, offeringId: offering.id };
      }

      const piv = await transaction.piv.create({
        data: { id: `piv_${ulid()}`, propertyId: input.propertyId, caseId: input.caseId },
        select: { id: true },
      });
      const offering = await transaction.offering.create({
        data: {
          id: `offering_${ulid()}`,
          pivId: piv.id,
          minimumRaiseEur: input.ipoValueEur,
          targetRaiseEur: input.ipoValueEur,
        },
        select: { id: true },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "offering.opened_for_approved_case",
          resourceType: "offering",
          resourceId: offering.id,
          changes: {
            trace_id: input.traceId,
            case_id: input.caseId,
            piv_id: piv.id,
            target_raise_eur: input.ipoValueEur,
          },
          createdAt: input.openedAt,
        },
      });
      return { pivId: piv.id, offeringId: offering.id };
    });
  }

  public async listPublic(input: ListPublicOfferingsInput): Promise<PublicOfferingRecord[]> {
    const rows = await this.database.offering.findMany({
      where: {
        status: { in: [...publicOfferingStatuses] },
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                { createdAt: input.after.createdAt, id: { lt: input.after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        status: true,
        targetRaiseEur: true,
        createdAt: true,
        piv: {
          select: {
            case: { select: { ipoEndAt: true } },
            property: {
              select: { propertyType: true, countryCode: true, city: true },
            },
          },
        },
      },
    });

    return rows.map((row) => {
      if (!isPublicOfferingStatus(row.status) || row.piv.property.propertyType !== "residential") {
        throw new Error("Database returned an offering outside the public contract");
      }

      return {
        id: row.id,
        status: row.status,
        targetRaiseEur: row.targetRaiseEur.toFixed(2),
        createdAt: row.createdAt,
        ipoEndAt: row.piv.case.ipoEndAt,
        property: {
          propertyType: row.piv.property.propertyType,
          countryCode: row.piv.property.countryCode,
          city: row.piv.property.city,
        },
      };
    });
  }

  public async getInvestorDetail(input: {
    offeringId: string;
    accountId: string;
  }): Promise<InvestorOfferingDetailRecord | null> {
    const [offering, account, progressRows] = await Promise.all([
      this.database.offering.findUnique({
        where: { id: input.offeringId },
        select: {
          id: true,
          status: true,
          minimumRaiseEur: true,
          targetRaiseEur: true,
          finalOfferingPublishedAt: true,
          platformRightsEndAt: true,
          effectiveRightsEndAt: true,
          piv: {
            select: {
              id: true,
              legalName: true,
              jurisdiction: true,
              registrationNo: true,
              structurePattern: true,
              incorporatedAt: true,
              case: {
                select: {
                  ipoEndAt: true,
                  appraisalValueOpinionEur: true,
                },
              },
              property: {
                select: {
                  id: true,
                  propertyType: true,
                  countryCode: true,
                  city: true,
                  addressLine: true,
                  ownerDeclaredValueEur: true,
                },
              },
            },
          },
          disclosurePacks: {
            where: { isCurrent: true, supersededAt: null },
            orderBy: [{ version: "desc" }, { id: "desc" }],
            take: 1,
            select: {
              id: true,
              version: true,
              publishedAt: true,
              documents: {
                orderBy: [{ isCoreReading: "desc" }, { documentType: "asc" }, { id: "asc" }],
                select: {
                  id: true,
                  documentType: true,
                  documentRef: true,
                  isCoreReading: true,
                },
              },
            },
          },
          materialityRecords: {
            orderBy: [{ classifiedAt: "desc" }, { id: "desc" }],
            select: {
              id: true,
              changeDescription: true,
              classification: true,
              resetTriggered: true,
              classifiedAt: true,
            },
          },
        },
      }),
      this.database.account.findUnique({
        where: { id: input.accountId },
        select: {
          status: true,
          loginMethods: { select: { methodType: true } },
          kycEligibility: {
            select: { eligibilityState: true, renewalDueAt: true },
          },
          walletRegistration: {
            select: { walletAddress: true, registeredAt: true },
          },
        },
      }),
      this.database.$queryRaw<
        Array<{ reserved_capacity_eur: string; funded_eur: string }>
      >`
        SELECT
          COALESCE(
            SUM(reservation.amount_eur) FILTER (
              WHERE reservation.reservation_stage NOT IN ('cancelled', 'lapsed')
            ),
            0
          )::text AS reserved_capacity_eur,
          COALESCE(
            SUM(latest_money.amount_eur) FILTER (
              WHERE reservation.reservation_stage NOT IN ('cancelled', 'lapsed')
                AND latest_money.capital_state IN (
                  'eurc_reserved',
                  'reconfirmation_pending',
                  'eurc_finalized'
                )
            ),
            0
          )::text AS funded_eur
        FROM offering.reservations AS reservation
        LEFT JOIN LATERAL (
          SELECT money_event.capital_state, money_event.amount_eur
          FROM money.money_events AS money_event
          WHERE money_event.reservation_id = reservation.reservation_id
          ORDER BY money_event.recorded_at DESC, money_event.money_event_id DESC
          LIMIT 1
        ) AS latest_money ON TRUE
        WHERE reservation.offering_id = ${input.offeringId}
      `,
    ]);

    if (offering === null || account === null) return null;
    if (offering.piv.property.propertyType !== "residential") {
      throw new Error(`Unknown property type: ${offering.piv.property.propertyType}`);
    }

    const disclosurePack = offering.disclosurePacks[0];
    const progress = progressRows[0];
    if (progress === undefined) {
      throw new Error("Offering progress query did not return an aggregate row");
    }

    return {
      id: offering.id,
      status: asInvestorOfferingStatus(offering.status),
      minimumRaiseEur: offering.minimumRaiseEur.toFixed(2),
      targetRaiseEur: offering.targetRaiseEur.toFixed(2),
      finalOfferingPublishedAt: offering.finalOfferingPublishedAt,
      platformRightsEndAt: offering.platformRightsEndAt,
      effectiveRightsEndAt: offering.effectiveRightsEndAt,
      ipoEndAt: offering.piv.case.ipoEndAt,
      issuer: {
        pivId: offering.piv.id,
        legalName: offering.piv.legalName,
        jurisdiction: offering.piv.jurisdiction,
        registrationNumber: offering.piv.registrationNo,
        structurePattern: offering.piv.structurePattern,
        incorporatedAt: offering.piv.incorporatedAt,
      },
      property: {
        propertyId: offering.piv.property.id,
        propertyType: offering.piv.property.propertyType,
        countryCode: offering.piv.property.countryCode,
        city: offering.piv.property.city,
        addressLine: offering.piv.property.addressLine,
        ownerDeclaredValueEur: offering.piv.property.ownerDeclaredValueEur.toFixed(2),
        appraisalValueOpinionEur:
          offering.piv.case.appraisalValueOpinionEur?.toFixed(2) ?? null,
      },
      currentDisclosurePack:
        disclosurePack === undefined
          ? null
          : {
              id: disclosurePack.id,
              version: disclosurePack.version,
              publishedAt: disclosurePack.publishedAt,
              documents: disclosurePack.documents,
            },
      materialityRecords: offering.materialityRecords,
      reservedCapacityEur: normalizeCurrency(progress.reserved_capacity_eur),
      fundedEur: normalizeCurrency(progress.funded_eur),
      accountReadiness: {
        status: asAccountStatus(account.status),
        loginMethods: account.loginMethods.map((method) =>
          asLoginMethod(method.methodType),
        ),
        kycEligibilityState: account.kycEligibility?.eligibilityState ?? null,
        kycRenewalDueAt: account.kycEligibility?.renewalDueAt ?? null,
        walletProvisioned: account.walletRegistration !== null,
        walletAddress: account.walletRegistration?.walletAddress ?? null,
        payoutWalletRegistered:
          account.walletRegistration !== null &&
          account.walletRegistration.registeredAt !== null,
      },
    };
  }

  public async getAccessibleDocument(input: {
    accountId: string;
    offeringId: string;
    documentId: string;
  }): Promise<AccessibleDisclosureDocumentRecord | null> {
    const rows = await this.database.$queryRaw<
      Array<{
        document_reference: string;
        document_type: string;
        disclosure_pack_version: number;
      }>
    >`
      SELECT
        document.document_ref AS document_reference,
        document.document_type,
        disclosure_pack.version AS disclosure_pack_version
      FROM offering.disclosure_documents AS document
      JOIN offering.disclosure_packs AS disclosure_pack
        ON disclosure_pack.disclosure_pack_id = document.disclosure_pack_id
      WHERE document.document_id = ${input.documentId}
        AND disclosure_pack.offering_id = ${input.offeringId}
        AND (
          (
            disclosure_pack.is_current = TRUE
            AND disclosure_pack.superseded_at IS NULL
          )
          OR EXISTS (
            SELECT 1
            FROM offering.reservations AS reservation
            WHERE reservation.offering_id = disclosure_pack.offering_id
              AND reservation.account_id = ${input.accountId}
              AND reservation.disclosure_pack_version_at_reservation =
                disclosure_pack.version::text
          )
        )
      LIMIT 1
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          documentReference: row.document_reference,
          documentType: row.document_type,
          disclosurePackVersion: row.disclosure_pack_version,
        };
  }

  public async createReservation(input: CreateReservationInput): Promise<CreateReservationResult> {
    return this.database.$transaction(async (transaction) => {
      // AD-146: lock the offering row so concurrent reservation attempts
      // against the same offering serialize, matching the FOR UPDATE
      // pattern PrismaOriginationRepository.submitInitialCase already uses.
      const locked = await transaction.$queryRaw<
        Array<{ offering_id: string; status: string; target_raise_eur: string }>
      >`
        SELECT offering_id, status, target_raise_eur::text
        FROM offering.offerings
        WHERE offering_id = ${input.offeringId}
        FOR UPDATE
      `;
      const offering = locked[0];
      if (offering === undefined || offering.status !== "pre_offering") {
        return { reservation: null, conflict: "offering_not_open" as const };
      }

      const reservedRows = await transaction.$queryRaw<Array<{ reserved_capacity_eur: string }>>`
        SELECT COALESCE(
          SUM(amount_eur) FILTER (WHERE reservation_stage NOT IN ('cancelled', 'lapsed')),
          0
        )::text AS reserved_capacity_eur
        FROM offering.reservations
        WHERE offering_id = ${input.offeringId}
      `;
      const reservedCapacityEur = reservedRows[0]?.reserved_capacity_eur ?? "0";
      const remainingCents = toCents(offering.target_raise_eur) - toCents(reservedCapacityEur);
      if (toCents(input.amountEur) > (remainingCents > 0n ? remainingCents : 0n)) {
        return { reservation: null, conflict: "capacity_exceeded" as const };
      }

      await transaction.reservation.create({
        data: {
          id: input.reservationId,
          offeringId: input.offeringId,
          accountId: input.accountId,
          amountEur: input.amountEur,
          reservationStage: "initiated",
          disclosurePackVersionAtReservation: input.disclosurePackVersionAtReservation,
          createdAt: input.createdAt,
        },
      });
      await transaction.moneyEvent.create({
        data: {
          id: `money_event_${ulid()}`,
          reservationId: input.reservationId,
          provider: "coinbase_cdp",
          capitalState: "initiated",
          amountEur: input.amountEur,
          recordedAt: input.createdAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "offering.reservation_created",
          resourceType: "reservation",
          resourceId: input.reservationId,
          changes: {
            trace_id: input.traceId,
            offering_id: input.offeringId,
            amount_eur: input.amountEur,
          },
          createdAt: input.createdAt,
        },
      });

      return {
        reservation: { reservationId: input.reservationId, createdAt: input.createdAt },
        conflict: null,
      };
    });
  }

  public async recordMoneyEvent(input: AdvanceReservationCapitalStateInput): Promise<void> {
    await this.database.moneyEvent.create({
      data: {
        id: `money_event_${ulid()}`,
        reservationId: input.reservationId,
        provider: input.provider,
        providerReference: input.providerReference,
        capitalState: input.capitalState,
        amountEur: input.amountEur,
        amountEurc: input.amountEurc,
        recordedAt: input.recordedAt,
      },
    });
  }

  public async listInitiatedReservationsForTimers(): Promise<InitiatedReservationForTimer[]> {
    const rows = await this.database.$queryRaw<
      Array<{
        reservation_id: string;
        offering_id: string;
        account_id: string;
        created_at: Date;
        latest_capital_state: string | null;
      }>
    >`
      SELECT
        reservation.reservation_id,
        reservation.offering_id,
        reservation.account_id,
        reservation.created_at,
        latest_money.capital_state AS latest_capital_state
      FROM offering.reservations AS reservation
      LEFT JOIN LATERAL (
        SELECT money_event.capital_state
        FROM money.money_events AS money_event
        WHERE money_event.reservation_id = reservation.reservation_id
        ORDER BY money_event.recorded_at DESC, money_event.money_event_id DESC
        LIMIT 1
      ) AS latest_money ON TRUE
      WHERE reservation.reservation_stage = 'initiated'
    `;
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      offeringId: row.offering_id,
      accountId: row.account_id,
      createdAt: row.created_at,
      latestCapitalState: row.latest_capital_state,
    }));
  }

  public async listPendingPurchaseReservationsForTimers(): Promise<PendingPurchaseReservationForTimer[]> {
    const rows = await this.database.$queryRaw<
      Array<{ reservation_id: string; account_id: string; amount_eur: string }>
    >`
      SELECT reservation.reservation_id, reservation.account_id, reservation.amount_eur::text
      FROM offering.reservations AS reservation
      JOIN LATERAL (
        SELECT money_event.capital_state
        FROM money.money_events AS money_event
        WHERE money_event.reservation_id = reservation.reservation_id
        ORDER BY money_event.recorded_at DESC, money_event.money_event_id DESC
        LIMIT 1
      ) AS latest_money ON TRUE
      WHERE reservation.reservation_stage = 'initiated'
        AND latest_money.capital_state = 'eurc_purchase_pending'
    `;
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      accountId: row.account_id,
      amountEur: row.amount_eur,
    }));
  }

  public async expireReservation(input: ExpireReservationInput): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ reservation_id: string }>>`
        SELECT reservation_id
        FROM offering.reservations
        WHERE reservation_id = ${input.reservationId}
        FOR UPDATE
      `;
      if (locked.length === 0) return false;

      const current = await transaction.reservation.findUniqueOrThrow({
        where: { id: input.reservationId },
        select: { reservationStage: true },
      });
      if (current.reservationStage !== "initiated") return false;

      await transaction.reservation.update({
        where: { id: input.reservationId },
        data: { reservationStage: "lapsed" },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "offering.reservation_lapsed",
          resourceType: "reservation",
          resourceId: input.reservationId,
          changes: {
            trace_id: input.traceId,
            previous_stage: "initiated",
            new_stage: "lapsed",
          },
          createdAt: input.expiredAt,
        },
      });
      return true;
    });
  }

  public async publishFinalOfferingTerms(
    input: PublishFinalOfferingTermsInput,
  ): Promise<PublishFinalOfferingTermsResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<
        Array<{
          offering_id: string;
          status: string;
          target_raise_eur: string;
          final_offering_published_at: Date | null;
        }>
      >`
        SELECT offering_id, status, target_raise_eur::text, final_offering_published_at
        FROM offering.offerings
        WHERE offering_id = ${input.offeringId}
        FOR UPDATE
      `;
      const offering = locked[0];
      if (offering === undefined) {
        return { published: null, conflict: "offering_not_found" as const };
      }
      if (offering.status !== "pre_offering") {
        return { published: null, conflict: "not_open" as const };
      }
      if (offering.final_offering_published_at !== null) {
        return { published: null, conflict: "already_published" as const };
      }

      const fundedRows = await transaction.$queryRaw<Array<{ funded_eur: string }>>`
        SELECT COALESCE(
          SUM(latest_money.amount_eur) FILTER (WHERE latest_money.capital_state = ANY(${[...FUNDED_CAPITAL_STATES]})),
          0
        )::text AS funded_eur
        FROM offering.reservations AS reservation
        LEFT JOIN LATERAL (
          SELECT money_event.capital_state, money_event.amount_eur
          FROM money.money_events AS money_event
          WHERE money_event.reservation_id = reservation.reservation_id
          ORDER BY money_event.recorded_at DESC, money_event.money_event_id DESC
          LIMIT 1
        ) AS latest_money ON TRUE
        WHERE reservation.offering_id = ${input.offeringId}
      `;
      const fundedEur = fundedRows[0]?.funded_eur ?? "0";
      if (
        !canPublishFinalOfferingTerms({
          status: offering.status,
          finalOfferingPublishedAt: offering.final_offering_published_at,
          targetRaiseEur: offering.target_raise_eur,
          fundedEur,
        })
      ) {
        return { published: null, conflict: "target_not_reached" as const };
      }

      // Locked alongside the offering row so a concurrent expiry sweep
      // cannot flip one of these out from under this transaction; a
      // concurrent onramp-poll INSERT into money_events is a narrower,
      // documented residual race (see docs/investor-offering.md) — an
      // append-only insert isn't blocked by a row lock on reservations.
      const reservations = await transaction.$queryRaw<
        Array<{ reservation_id: string; amount_eur: string; latest_capital_state: string | null }>
      >`
        SELECT
          reservation.reservation_id,
          reservation.amount_eur::text,
          latest_money.capital_state AS latest_capital_state
        FROM offering.reservations AS reservation
        LEFT JOIN LATERAL (
          SELECT money_event.capital_state
          FROM money.money_events AS money_event
          WHERE money_event.reservation_id = reservation.reservation_id
          ORDER BY money_event.recorded_at DESC, money_event.money_event_id DESC
          LIMIT 1
        ) AS latest_money ON TRUE
        WHERE reservation.offering_id = ${input.offeringId}
          AND reservation.reservation_stage = 'initiated'
        FOR UPDATE OF reservation
      `;

      let reservationsAwaitingReconfirmation = 0;
      let reservationsCancelled = 0;
      for (const reservation of reservations) {
        const funded =
          reservation.latest_capital_state !== null &&
          (FUNDED_CAPITAL_STATES as readonly string[]).includes(reservation.latest_capital_state);
        if (funded) {
          await transaction.reservation.update({
            where: { id: reservation.reservation_id },
            data: { reservationStage: "awaiting_reconfirmation" },
          });
          await transaction.moneyEvent.create({
            data: {
              id: `money_event_${ulid()}`,
              reservationId: reservation.reservation_id,
              provider: "internal",
              capitalState: "reconfirmation_pending",
              amountEur: reservation.amount_eur,
              recordedAt: input.publishedAt,
            },
          });
          reservationsAwaitingReconfirmation += 1;
        } else {
          await transaction.reservation.update({
            where: { id: reservation.reservation_id },
            data: { reservationStage: "cancelled" },
          });
          reservationsCancelled += 1;
        }
      }

      const platformRightsEndAt = computeEffectiveRightsEndAt(input.publishedAt);
      // PAYMENT_FLOWS.md's "Effective Investor-Rights Window Override": no
      // broader statutory/supplement-based rights table is documented
      // anywhere to compute a real max() over, so this uses the 168-hour
      // platform default directly (domain/finalization.policy.ts).
      const effectiveRightsEndAt = platformRightsEndAt;

      // offerings.status deliberately stays 'pre_offering' here — per
      // CORE_TABLES.md it only becomes 'final_offering' once
      // commitOfferingFinalization runs after the window closes.
      await transaction.offering.update({
        where: { id: input.offeringId },
        data: {
          finalOfferingPublishedAt: input.publishedAt,
          platformRightsEndAt,
          effectiveRightsEndAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "offering.final_terms_published",
          resourceType: "offering",
          resourceId: input.offeringId,
          changes: {
            trace_id: input.traceId,
            founder_review_notes: input.founderReviewNotes,
            funded_eur: fundedEur,
            target_raise_eur: offering.target_raise_eur,
            effective_rights_end_at: effectiveRightsEndAt.toISOString(),
            reservations_awaiting_reconfirmation: reservationsAwaitingReconfirmation,
            reservations_cancelled: reservationsCancelled,
          },
          createdAt: input.publishedAt,
        },
      });

      return {
        published: {
          offeringId: input.offeringId,
          finalOfferingPublishedAt: input.publishedAt,
          platformRightsEndAt,
          effectiveRightsEndAt,
          reservationsAwaitingReconfirmation,
          reservationsCancelled,
        },
        conflict: null,
      };
    });
  }

  public async reconfirmReservation(input: ReconfirmReservationInput): Promise<ReconfirmReservationResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<
        Array<{ reservation_id: string; account_id: string; offering_id: string; reservation_stage: string }>
      >`
        SELECT reservation_id, account_id, offering_id, reservation_stage
        FROM offering.reservations
        WHERE reservation_id = ${input.reservationId}
        FOR UPDATE
      `;
      const reservation = locked[0];
      // Not found and not-yours both report the same conflict, deliberately
      // — a reservation ID belonging to someone else must not be
      // distinguishable from one that doesn't exist.
      if (reservation === undefined || reservation.account_id !== input.accountId) {
        return { reconfirmedAt: null, conflict: "not_found" as const };
      }
      if (reservation.reservation_stage !== "awaiting_reconfirmation") {
        return { reconfirmedAt: null, conflict: "not_awaiting_reconfirmation" as const };
      }

      const offering = await transaction.offering.findUniqueOrThrow({
        where: { id: reservation.offering_id },
        select: {
          effectiveRightsEndAt: true,
          disclosurePacks: {
            where: { isCurrent: true, supersededAt: null },
            select: { version: true },
            take: 1,
          },
        },
      });
      if (
        offering.effectiveRightsEndAt === null ||
        !isReconfirmationWindowOpen({ effectiveRightsEndAt: offering.effectiveRightsEndAt, now: input.reconfirmedAt })
      ) {
        return { reconfirmedAt: null, conflict: "window_closed" as const };
      }

      await transaction.reservation.update({
        where: { id: input.reservationId },
        data: { reservationStage: "reconfirmed", reconfirmedAt: input.reconfirmedAt },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "offering.reservation_reconfirmed",
          resourceType: "reservation",
          resourceId: input.reservationId,
          changes: {
            trace_id: input.traceId,
            // PAYMENT_FLOWS.md: "Reconfirmation must reference a specific
            // disclosure-pack version and that version must remain
            // downloadable for audit purposes."
            disclosure_pack_version: offering.disclosurePacks[0]?.version ?? null,
          },
          createdAt: input.reconfirmedAt,
        },
      });

      return { reconfirmedAt: input.reconfirmedAt, conflict: null };
    });
  }

  public async listOfferingsPendingFinalizationCommit(): Promise<OfferingPendingFinalizationCommit[]> {
    const rows = await this.database.offering.findMany({
      where: { status: "pre_offering", finalOfferingPublishedAt: { not: null } },
      select: { id: true, effectiveRightsEndAt: true },
    });
    return rows
      .filter((row) => row.effectiveRightsEndAt !== null)
      .map((row) => ({ offeringId: row.id, effectiveRightsEndAt: row.effectiveRightsEndAt! }));
  }

  public async commitOfferingFinalization(
    input: CommitOfferingFinalizationInput,
  ): Promise<CommitOfferingFinalizationResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<
        Array<{
          offering_id: string;
          status: string;
          final_offering_published_at: Date | null;
          effective_rights_end_at: Date | null;
        }>
      >`
        SELECT offering_id, status, final_offering_published_at, effective_rights_end_at
        FROM offering.offerings
        WHERE offering_id = ${input.offeringId}
        FOR UPDATE
      `;
      const offering = locked[0];
      if (offering === undefined) {
        return { committed: null, conflict: "offering_not_found" as const };
      }
      if (offering.status !== "pre_offering" || offering.final_offering_published_at === null) {
        return { committed: null, conflict: "not_publishable_state" as const };
      }
      if (
        offering.effective_rights_end_at === null ||
        isReconfirmationWindowOpen({ effectiveRightsEndAt: offering.effective_rights_end_at, now: input.finalizedAt })
      ) {
        return { committed: null, conflict: "window_still_open" as const };
      }

      const reservations = await transaction.$queryRaw<
        Array<{
          reservation_id: string;
          account_id: string;
          amount_eur: string;
          reservation_stage: string;
          wallet_address: string | null;
        }>
      >`
        SELECT
          reservation.reservation_id,
          reservation.account_id,
          reservation.amount_eur::text,
          reservation.reservation_stage,
          wallet.wallet_address
        FROM offering.reservations AS reservation
        LEFT JOIN settlement.wallet_registrations AS wallet
          ON wallet.account_id = reservation.account_id
        WHERE reservation.offering_id = ${input.offeringId}
          AND reservation.reservation_stage IN ('awaiting_reconfirmation', 'reconfirmed')
        FOR UPDATE OF reservation
      `;

      const piv = await transaction.offering.findUniqueOrThrow({
        where: { id: input.offeringId },
        select: { pivId: true },
      });

      let positionsCreated = 0;
      let reservationsLapsed = 0;
      for (const reservation of reservations) {
        if (reservation.reservation_stage === "reconfirmed") {
          await transaction.positionLedger.create({
            data: {
              id: `position_${ulid()}`,
              reservationId: reservation.reservation_id,
              pivId: piv.pivId,
              accountId: reservation.account_id,
              unitCount: costBasisToUnitCount(reservation.amount_eur),
              costBasisEur: reservation.amount_eur,
              holderWalletAddress: reservation.wallet_address,
            },
          });
          await transaction.reservation.update({
            where: { id: reservation.reservation_id },
            data: { reservationStage: "finalized", reservationFinalizedAt: input.finalizedAt },
          });
          await transaction.moneyEvent.create({
            data: {
              id: `money_event_${ulid()}`,
              reservationId: reservation.reservation_id,
              provider: "internal",
              capitalState: "eurc_finalized",
              amountEur: reservation.amount_eur,
              recordedAt: input.finalizedAt,
            },
          });
          positionsCreated += 1;
        } else {
          // 'awaiting_reconfirmation' that never reconfirmed. PAYMENT_FLOWS.md's
          // Silence rule: "No reconfirmation by expiry means the reservation
          // lapses rather than silently finalizing."
          await transaction.reservation.update({
            where: { id: reservation.reservation_id },
            data: { reservationStage: "lapsed" },
          });
          reservationsLapsed += 1;
        }
      }

      await transaction.offering.update({
        where: { id: input.offeringId },
        data: { status: "final_offering" },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: null,
          action: "offering.finalized",
          resourceType: "offering",
          resourceId: input.offeringId,
          changes: {
            trace_id: input.traceId,
            positions_created: positionsCreated,
            reservations_lapsed: reservationsLapsed,
          },
          createdAt: input.finalizedAt,
        },
      });

      return {
        committed: { offeringId: input.offeringId, positionsCreated, reservationsLapsed },
        conflict: null,
      };
    });
  }
}

function asInvestorOfferingStatus(
  value: string,
): InvestorOfferingDetailRecord["status"] {
  if (value === "pre_offering" || value === "final_offering" || value === "closed") {
    return value;
  }
  throw new Error(`Unknown offering status: ${value}`);
}

function asAccountStatus(
  value: string,
): InvestorOfferingDetailRecord["accountReadiness"]["status"] {
  if (
    value === "active" ||
    value === "recovery_review" ||
    value === "suspended_restricted"
  ) {
    return value;
  }
  throw new Error(`Unknown account status: ${value}`);
}

function asLoginMethod(
  value: string,
): InvestorOfferingDetailRecord["accountReadiness"]["loginMethods"][number] {
  if (value === "google" || value === "email_password") return value;
  throw new Error(`Unknown login method: ${value}`);
}

function normalizeCurrency(value: string): string {
  const [euros, fraction = "00"] = value.split(".");
  const cents = BigInt(euros!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
