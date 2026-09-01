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

export class PrismaOfferingRepository
  implements OfferingRepository, DisclosureDocumentRepository
{
  public constructor(private readonly database: DatabaseClient) {}

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
            select: { registeredAt: true },
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
