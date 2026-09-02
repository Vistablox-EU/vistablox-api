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

export class PrismaOfferingRepository
  implements
    OfferingRepository,
    DisclosureDocumentRepository,
    OfferingOriginationHandoffRepository,
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
