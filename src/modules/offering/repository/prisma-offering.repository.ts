import type { PgBoss } from "pg-boss";
import { ulid } from "ulid";
import { z } from "zod";

import { enqueueTransactionalJob } from "../../../shared/jobs/enqueue-job.js";
import type { KycEligibilityReader } from "../../identity/repository/kyc-eligibility-reader.js";
import { toCents, toEurcMicros } from "../domain/currency.js";
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
import { materialityResetTriggered } from "../domain/materiality.policy.js";
import { isCompleteDisclosurePack, isCoreReadingDocumentType, type DisclosureDocumentType } from "../domain/disclosure-pack.policy.js";
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
import type { ClassifyMaterialityInput, ClassifyMaterialityResult, MaterialityRepository } from "./materiality.repository.js";
import type {
  DisclosurePackRepository,
  PublishDisclosurePackInput,
  PublishDisclosurePackResult,
} from "./disclosure-pack.repository.js";
import type {
  ReconfirmationReminderRepository,
  RecordReconfirmationReminderSentInput,
  ReservationAwaitingReconfirmationReminder,
} from "./reconfirmation-reminder.repository.js";
import type {
  ReconfirmationWindowOpenedNotificationRepository,
  RecordReconfirmationWindowOpenedNotificationSentInput,
  ReservationForReconfirmationWindowOpenedNotification,
} from "./reconfirmation-window-opened-notification.repository.js";

const reconfirmationReminderIntervalHoursSettingSchema = z.object({ hours: z.number().int().min(1).max(168) });

export class PrismaOfferingRepository
  implements
    OfferingRepository,
    DisclosureDocumentRepository,
    OfferingOriginationHandoffRepository,
    FinalizeOfferingRepository,
    MaterialityRepository,
    DisclosurePackRepository,
    ReconfirmationReminderRepository,
    ReconfirmationWindowOpenedNotificationRepository,
    ReservationRepository
{
  public constructor(
    private readonly database: DatabaseClient,
    private readonly pgBoss: PgBoss,
    private readonly kycEligibilityReader: KycEligibilityReader,
  ) {}

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

      const originationCase = await transaction.originationCase.findUniqueOrThrow({
        where: { id: input.caseId },
        select: { ipoEndAt: true },
      });
      if (originationCase.ipoEndAt === null) {
        throw new Error(
          `Origination case ${input.caseId} has no ipo_end_at set; cannot open an IPO escrow campaign without a deadline.`,
        );
      }

      // AD-256's escrow needs a concrete token_id to open a campaign against
      // before any minting can happen -- earlier than AD-163's original
      // "once minted" framing for pivs.token_id, so it's assigned here
      // instead, at Piv creation, via the dedicated sequence
      // (20260904090000_add_piv_token_id_sequence).
      const tokenIdRows = await transaction.$queryRaw<{ next_token_id: bigint | string }[]>`
        SELECT nextval('origination.piv_token_id_seq') AS next_token_id
      `;
      const tokenId = BigInt(tokenIdRows[0]!.next_token_id);

      const piv = await transaction.piv.create({
        data: {
          id: `piv_${ulid()}`,
          propertyId: input.propertyId,
          caseId: input.caseId,
          tokenId: tokenId.toString(),
        },
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
            token_id: tokenId.toString(),
          },
          createdAt: input.openedAt,
        },
      });

      // AD-256: durably hand off, in this same transaction, to the job that
      // opens this Piv's IPO escrow campaign on-chain -- the same
      // enqueue-in-transaction pattern AD-145 already uses one step earlier
      // (origination approval -> this method). Only reached on first
      // creation of a Piv: the existingPiv branch above (a replay of this
      // job) must not re-open an already-open campaign, which the escrow
      // contract itself would reject anyway (CampaignAlreadyOpened).
      await enqueueTransactionalJob(
        this.pgBoss,
        transaction,
        "settlement.open_ipo_escrow_campaign",
        {
          piv_id: piv.id,
          token_id: tokenId.toString(),
          target_amount_eurc: toEurcMicros(input.ipoValueEur).toString(),
          deadline_unix: Math.floor(originationCase.ipoEndAt.getTime() / 1_000),
        },
        input.traceId,
      );

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
    const [offering, account, progressRows, kycSnapshot] = await Promise.all([
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
          walletRegistration: {
            select: { walletAddress: true, registeredAt: true },
          },
          recoveryCases: {
            where: { cooldownEndsAt: { not: null } },
            orderBy: { cooldownEndsAt: "desc" },
            take: 1,
            select: { cooldownEndsAt: true },
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
      this.kycEligibilityReader.getEligibilitySnapshot(input.accountId),
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
        kycEligibilityState: kycSnapshot?.eligibilityState ?? null,
        kycRenewalDueAt: kycSnapshot?.renewalDueAt ?? null,
        walletProvisioned: account.walletRegistration !== null,
        walletAddress: account.walletRegistration?.walletAddress ?? null,
        payoutWalletRegistered:
          account.walletRegistration !== null &&
          account.walletRegistration.registeredAt !== null,
        recoveryCooldownEndsAt: account.recoveryCases[0]?.cooldownEndsAt ?? null,
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
          case_id: string;
        }>
      >`
        SELECT
          offering.offering_id,
          offering.status,
          offering.target_raise_eur::text,
          offering.final_offering_published_at,
          piv.case_id
        FROM offering.offerings AS offering
        JOIN origination.pivs AS piv ON piv.piv_id = offering.piv_id
        WHERE offering.offering_id = ${input.offeringId}
        FOR UPDATE OF offering
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

      // PAYMENT_FLOWS.md's Phase-1 Final Offering Settlement Flow, step 4:
      // "VistaBlox publishes the locked final package, emits
      // final_offering_published_at, and moves live reservations into
      // reconfirmation_pending" — bundles publishing the disclosure package
      // together with this step, not as a separately-timed staff action.
      // Skipping this would open the reconfirmation window (and, per
      // AD-214, start the clock toward the Silence rule) while no investor
      // could actually reconfirm — reconfirmReservation already enforces
      // the same completeness rule at reconfirmation time; this closes the
      // gap where the window opens against a pack no one can act on yet.
      const currentPack = await transaction.disclosurePack.findFirst({
        where: { offeringId: input.offeringId, isCurrent: true, supersededAt: null },
        select: { documents: { select: { documentType: true } } },
      });
      const currentDocumentTypes = (currentPack?.documents ?? []).map(
        (document) => document.documentType as DisclosureDocumentType,
      );
      if (!isCompleteDisclosurePack(currentDocumentTypes)) {
        return { published: null, conflict: "disclosure_pack_incomplete" as const };
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
      const reservationIdsAwaitingReconfirmation: string[] = [];
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
          reservationIdsAwaitingReconfirmation.push(reservation.reservation_id);
        } else {
          // Structurally unreachable under the current rules, not dead code
          // to delete: canPublishFinalOfferingTerms (AD-245, no partial
          // funding) only lets execution reach this point once fundedEur has
          // reached the full target, and createReservation caps total
          // reserved capacity at that same target -- so by the time this
          // gate passes, every reserved euro must already be funded, leaving
          // nothing here to cancel. Kept for correctness of the loop (and in
          // case AD-245 is ever revisited) rather than special-cased away.
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

      // AD-214 / PAYMENT_FLOWS.md's Start-event meaning: "investor
      // notification is sent" — durably handed off (AD-145) rather than
      // sent synchronously here, the same cross-domain discipline
      // case_timers.pre_offering_open_handoff already established. Never
      // enqueued when nothing moved to awaiting_reconfirmation (an
      // all-cancelled publish, though target_not_reached would already have
      // blocked that in practice).
      if (reservationIdsAwaitingReconfirmation.length > 0) {
        await enqueueTransactionalJob(
          this.pgBoss,
          transaction,
          "case_timers.offering_reconfirmation_window_opened",
          {
            offering_id: input.offeringId,
            reservation_ids: reservationIdsAwaitingReconfirmation,
          },
          input.traceId,
        );
      }

      // AD-145/AD-248: reaching this point means canPublishFinalOfferingTerms
      // already confirmed the case's ipo_value_eur is fully collected
      // (AD-245) — unlike the reconfirmation-window job just above, this
      // handoff does not depend on whether any individual reservation
      // needed reconfirmation, so it is never gated on that count.
      await enqueueTransactionalJob(
        this.pgBoss,
        transaction,
        "case_timers.post_ipo_structuring_handoff",
        { case_id: offering.case_id },
        input.traceId,
      );

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
            select: { version: true, documents: { select: { documentType: true } } },
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

      // AD-037: "An investor must not be able to reconfirm against an
      // incomplete, draft, or superseded pack." No current pack at all is
      // the same failure as an incomplete one — isCompleteDisclosurePack([])
      // is false — so a missing pack doesn't need its own branch here.
      const currentPack = offering.disclosurePacks[0];
      const currentDocumentTypes = (currentPack?.documents ?? []).map(
        (document) => document.documentType as DisclosureDocumentType,
      );
      if (!isCompleteDisclosurePack(currentDocumentTypes)) {
        return { reconfirmedAt: null, conflict: "disclosure_pack_incomplete" as const };
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

  public async classifyMateriality(input: ClassifyMaterialityInput): Promise<ClassifyMaterialityResult> {
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
        return { classified: null, conflict: "offering_not_found" as const };
      }
      // "Post-publication change" only means something once publication has
      // happened, and only up to the moment commitOfferingFinalization
      // actually commits (AD-046 puts post-finalization worsening through a
      // separate amendment/consent path this codebase does not build here).
      if (offering.status !== "pre_offering" || offering.final_offering_published_at === null) {
        return { classified: null, conflict: "no_active_reconfirmation_window" as const };
      }

      const resetTriggered = materialityResetTriggered(input.classification);
      let effectiveRightsEndAt = offering.effective_rights_end_at;
      let reservationsReset = 0;

      if (resetTriggered) {
        // Only already-reconfirmed reservations have anything to invalidate;
        // ones still awaiting_reconfirmation are untouched by a reset — they
        // simply reconfirm (or not) against the now-later window like normal.
        const reconfirmed = await transaction.$queryRaw<Array<{ reservation_id: string }>>`
          SELECT reservation.reservation_id
          FROM offering.reservations AS reservation
          WHERE reservation.offering_id = ${input.offeringId}
            AND reservation.reservation_stage = 'reconfirmed'
          FOR UPDATE OF reservation
        `;
        for (const reservation of reconfirmed) {
          await transaction.reservation.update({
            where: { id: reservation.reservation_id },
            data: { reservationStage: "awaiting_reconfirmation", reconfirmedAt: null },
          });
        }
        reservationsReset = reconfirmed.length;

        // "Resets the full 168-hour window" (PAYMENT_FLOWS.md) — a fresh
        // 168 hours from this reset, not merely extending the old boundary.
        // Reusing this same field is also what correctly reopens a window
        // that had already lapsed by clock time but whose reservations the
        // hourly commit job hasn't processed yet.
        effectiveRightsEndAt = computeEffectiveRightsEndAt(input.classifiedAt);
        await transaction.offering.update({
          where: { id: input.offeringId },
          data: {
            platformRightsEndAt: effectiveRightsEndAt,
            effectiveRightsEndAt,
          },
        });
      }

      const materialityRecordId = `materiality_${ulid()}`;
      await transaction.materialityRecord.create({
        data: {
          id: materialityRecordId,
          offeringId: input.offeringId,
          changeDescription: input.changeDescription,
          classification: input.classification,
          thresholdType: input.thresholdType,
          resetTriggered,
          classifiedByAccountId: input.accountId,
          classifiedAt: input.classifiedAt,
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "offering.materiality_classified",
          resourceType: "offering",
          resourceId: input.offeringId,
          changes: {
            trace_id: input.traceId,
            change_description: input.changeDescription,
            classification: input.classification,
            threshold_type: input.thresholdType,
            reset_triggered: resetTriggered,
            reservations_reset: reservationsReset,
          },
          createdAt: input.classifiedAt,
        },
      });

      return {
        classified: {
          materialityRecordId,
          offeringId: input.offeringId,
          classification: input.classification,
          thresholdType: input.thresholdType,
          resetTriggered,
          classifiedAt: input.classifiedAt,
          effectiveRightsEndAt,
          reservationsReset,
        },
        conflict: null,
      };
    });
  }

  public async publishDisclosurePack(input: PublishDisclosurePackInput): Promise<PublishDisclosurePackResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await transaction.$queryRaw<Array<{ offering_id: string; status: string }>>`
        SELECT offering_id, status
        FROM offering.offerings
        WHERE offering_id = ${input.offeringId}
        FOR UPDATE
      `;
      const offering = locked[0];
      if (offering === undefined) {
        return { published: null, conflict: "offering_not_found" as const };
      }
      // Same window every other offering-lifecycle write in this module
      // operates in — AD-046 puts post-finalization content changes through
      // a separate amendment/consent path this codebase does not build.
      if (offering.status !== "pre_offering") {
        return { published: null, conflict: "not_open" as const };
      }

      const current = await transaction.disclosurePack.findFirst({
        where: { offeringId: input.offeringId, isCurrent: true, supersededAt: null },
        orderBy: [{ version: "desc" }],
      });
      if (current !== null) {
        await transaction.disclosurePack.update({
          where: { id: current.id },
          data: { isCurrent: false, supersededAt: input.publishedAt },
        });
      }

      const version = (current?.version ?? 0) + 1;
      const disclosurePackId = `pack_${ulid()}`;
      const created = await transaction.disclosurePack.create({
        data: {
          id: disclosurePackId,
          offeringId: input.offeringId,
          version,
          publishedAt: input.publishedAt,
          isCurrent: true,
          documents: {
            create: input.documents.map((document) => ({
              id: `document_${ulid()}`,
              documentType: document.documentType,
              documentRef: document.documentRef,
              isCoreReading: isCoreReadingDocumentType(document.documentType),
            })),
          },
        },
        include: { documents: true },
      });

      const documentTypes = input.documents.map((document) => document.documentType);
      const isComplete = isCompleteDisclosurePack(documentTypes);

      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.accountId,
          action: "offering.disclosure_pack_published",
          resourceType: "offering",
          resourceId: input.offeringId,
          changes: {
            trace_id: input.traceId,
            disclosure_pack_id: disclosurePackId,
            version,
            document_types: documentTypes,
            is_complete: isComplete,
            superseded_pack_id: current?.id ?? null,
          },
          createdAt: input.publishedAt,
        },
      });

      return {
        published: {
          disclosurePackId,
          offeringId: input.offeringId,
          version,
          publishedAt: input.publishedAt,
          documents: created.documents.map((document) => ({
            documentId: document.id,
            documentType: document.documentType as DisclosureDocumentType,
            documentRef: document.documentRef,
            isCoreReading: document.isCoreReading,
          })),
          isComplete,
          supersededPackId: current?.id ?? null,
        },
        conflict: null,
      };
    });
  }

  public async getReconfirmationReminderIntervalHours(): Promise<number> {
    const setting = await this.database.platformSetting.findUnique({
      where: { key: "offering.reconfirmation_reminder_interval_hours" },
      select: { value: true },
    });
    if (setting === null) {
      throw new Error("Missing offering.reconfirmation_reminder_interval_hours setting");
    }
    return reconfirmationReminderIntervalHoursSettingSchema.parse(setting.value).hours;
  }

  public async listReservationsAwaitingReconfirmationForReminders(): Promise<
    ReservationAwaitingReconfirmationReminder[]
  > {
    const rows = await this.database.$queryRaw<
      Array<{
        reservation_id: string;
        account_id: string;
        contact_email: string | null;
        offering_id: string;
        final_offering_published_at: Date;
        effective_rights_end_at: Date;
        last_reminder_sent_at: Date | null;
      }>
    >`
      SELECT
        reservation.reservation_id,
        reservation.account_id,
        account.protected_contact_email AS contact_email,
        reservation.offering_id,
        offering.final_offering_published_at,
        offering.effective_rights_end_at,
        latest_reminder.created_at AS last_reminder_sent_at
      FROM offering.reservations AS reservation
      JOIN offering.offerings AS offering ON offering.offering_id = reservation.offering_id
      JOIN account.accounts AS account ON account.account_id = reservation.account_id
      LEFT JOIN LATERAL (
        SELECT audit_log.created_at
        FROM audit.audit_log AS audit_log
        WHERE audit_log.resource_type = 'reservation'
          AND audit_log.resource_id = reservation.reservation_id
          AND audit_log.action = 'offering.reconfirmation_reminder_sent'
        ORDER BY audit_log.created_at DESC
        LIMIT 1
      ) AS latest_reminder ON TRUE
      WHERE reservation.reservation_stage = 'awaiting_reconfirmation'
        AND offering.final_offering_published_at IS NOT NULL
        AND offering.effective_rights_end_at IS NOT NULL
    `;
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      accountId: row.account_id,
      contactEmail: row.contact_email,
      offeringId: row.offering_id,
      finalOfferingPublishedAt: row.final_offering_published_at,
      effectiveRightsEndAt: row.effective_rights_end_at,
      lastReminderSentAt: row.last_reminder_sent_at,
    }));
  }

  public async recordReconfirmationReminderSent(input: RecordReconfirmationReminderSentInput): Promise<void> {
    await this.database.auditLog.create({
      data: {
        id: `audit_${ulid()}`,
        actorAccountId: null,
        action: "offering.reconfirmation_reminder_sent",
        resourceType: "reservation",
        resourceId: input.reservationId,
        changes: { trace_id: input.traceId },
        createdAt: input.sentAt,
      },
    });
  }

  public async getReservationsForReconfirmationWindowOpenedNotification(
    reservationIds: string[],
  ): Promise<ReservationForReconfirmationWindowOpenedNotification[]> {
    // Selects a raw timestamp and derives the boolean below in JS, rather
    // than a SQL-computed boolean column — the same "was X already done"
    // shape listReservationsAwaitingReconfirmationForReminders already
    // proves out (last_reminder_sent_at), instead of an untested pattern.
    const rows = await this.database.$queryRaw<
      Array<{
        reservation_id: string;
        contact_email: string | null;
        effective_rights_end_at: Date;
        notification_sent_at: Date | null;
      }>
    >`
      SELECT
        reservation.reservation_id,
        account.protected_contact_email AS contact_email,
        offering.effective_rights_end_at,
        already_sent.created_at AS notification_sent_at
      FROM offering.reservations AS reservation
      JOIN offering.offerings AS offering ON offering.offering_id = reservation.offering_id
      JOIN account.accounts AS account ON account.account_id = reservation.account_id
      LEFT JOIN LATERAL (
        SELECT audit_log.created_at
        FROM audit.audit_log AS audit_log
        WHERE audit_log.resource_type = 'reservation'
          AND audit_log.resource_id = reservation.reservation_id
          AND audit_log.action = 'offering.reconfirmation_window_opened_notification_sent'
        LIMIT 1
      ) AS already_sent ON TRUE
      WHERE reservation.reservation_id = ANY(${reservationIds})
    `;
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      contactEmail: row.contact_email,
      effectiveRightsEndAt: row.effective_rights_end_at,
      notificationAlreadySent: row.notification_sent_at !== null,
    }));
  }

  public async recordReconfirmationWindowOpenedNotificationSent(
    input: RecordReconfirmationWindowOpenedNotificationSentInput,
  ): Promise<void> {
    await this.database.auditLog.create({
      data: {
        id: `audit_${ulid()}`,
        actorAccountId: null,
        action: "offering.reconfirmation_window_opened_notification_sent",
        resourceType: "reservation",
        resourceId: input.reservationId,
        changes: { trace_id: input.traceId },
        createdAt: input.sentAt,
      },
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
  if (value === "google" || value === "apple" || value === "passkey" || value === "device_key") {
    return value;
  }
  throw new Error(`Unknown login method: ${value}`);
}

function normalizeCurrency(value: string): string {
  const [euros, fraction = "00"] = value.split(".");
  const cents = BigInt(euros!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
