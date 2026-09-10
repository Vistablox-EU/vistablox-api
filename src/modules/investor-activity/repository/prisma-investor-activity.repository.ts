import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import {
  type InvestorActivityRepository,
  type InvestorActivitySummary,
  type InvestorActivitySummaryReader,
  type InvestorPositionRecord,
  type InvestorPropertySummary,
  type InvestorReservationRecord,
} from "./investor-activity.repository.js";

export class PrismaInvestorActivityRepository
  implements InvestorActivityRepository, InvestorActivitySummaryReader
{
  public constructor(private readonly database: DatabaseClient) {}

  public async getSummary(accountId: string): Promise<InvestorActivitySummary> {
    const account = await this.database.account.findUnique({
      where: { id: accountId },
      select: {
        _count: {
          select: {
            reservations: true,
            positions: {
              where: {
                positionStatus: { in: ["pending_internal_settlement", "active"] },
              },
            },
          },
        },
      },
    });
    return {
      reservationCount: account?._count.reservations ?? 0,
      activePositionCount: account?._count.positions ?? 0,
    };
  }

  public async listReservations(input: {
    accountId: string;
    limit: number;
    after?: { createdAt: Date; id: string };
  }): Promise<InvestorReservationRecord[]> {
    const rows = await this.database.reservation.findMany({
      where: {
        accountId: input.accountId,
        ...(input.after === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.after.createdAt } },
                {
                  createdAt: input.after.createdAt,
                  id: { lt: input.after.id },
                },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
      select: {
        id: true,
        offeringId: true,
        amountEur: true,
        reservationStage: true,
        disclosurePackVersionAtReservation: true,
        reconfirmedAt: true,
        reservationFinalizedAt: true,
        createdAt: true,
        offering: {
          select: {
            status: true,
            piv: {
              select: {
                property: {
                  select: { propertyType: true, countryCode: true, city: true },
                },
              },
            },
          },
        },
        moneyEvents: {
          orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            capitalState: true,
            amountEur: true,
            amountEurc: true,
            recordedAt: true,
          },
        },
      },
    });

    return rows.map((row) => {
      const property = toPropertySummary(row.offering.piv.property);
      const latestMoneyEvent = row.moneyEvents[0];
      return {
        reservationId: row.id,
        offeringId: row.offeringId,
        offeringStatus: asOfferingStatus(row.offering.status),
        amountEur: row.amountEur.toFixed(2),
        reservationStage: asReservationStage(row.reservationStage),
        disclosurePackVersionAtReservation:
          row.disclosurePackVersionAtReservation,
        reconfirmedAt: row.reconfirmedAt,
        reservationFinalizedAt: row.reservationFinalizedAt,
        createdAt: row.createdAt,
        latestMoneyEvent:
          latestMoneyEvent === undefined
            ? null
            : {
                capitalState: asCapitalState(latestMoneyEvent.capitalState),
                amountEur: latestMoneyEvent.amountEur.toFixed(2),
                amountEurc: latestMoneyEvent.amountEurc?.toFixed(6) ?? null,
                recordedAt: latestMoneyEvent.recordedAt,
              },
        property,
      };
    });
  }

  public async listCurrentPositions(input: {
    accountId: string;
    limit: number;
    after?: { activatedAt: Date | null; id: string };
  }): Promise<InvestorPositionRecord[]> {
    const rows = await this.database.positionLedger.findMany({
      where: {
        accountId: input.accountId,
        positionStatus: { in: ["pending_internal_settlement", "active"] },
        ...(input.after === undefined
          ? {}
          : input.after.activatedAt === null
            ? { activatedAt: null, id: { lt: input.after.id } }
            : {
                OR: [
                  { activatedAt: { lt: input.after.activatedAt } },
                  {
                    activatedAt: input.after.activatedAt,
                    id: { lt: input.after.id },
                  },
                  { activatedAt: null },
                ],
              }),
      },
      orderBy: [
        { activatedAt: { sort: "desc", nulls: "last" } },
        { id: "desc" },
      ],
      take: input.limit,
      select: {
        id: true,
        reservationId: true,
        pivId: true,
        unitCount: true,
        costBasisEur: true,
        positionStatus: true,
        activatedAt: true,
        reservation: { select: { offeringId: true } },
        piv: {
          select: {
            property: {
              select: { propertyType: true, countryCode: true, city: true },
            },
          },
        },
      },
    });

    return rows.map((row) => ({
      positionId: row.id,
      reservationId: row.reservationId,
      offeringId: row.reservation?.offeringId ?? null,
      pivId: row.pivId,
      unitCount: row.unitCount.toFixed(6),
      costBasisEur: row.costBasisEur.toFixed(2),
      positionStatus: asCurrentPositionStatus(row.positionStatus),
      activatedAt: row.activatedAt,
      property: toPropertySummary(row.piv.property),
    }));
  }
}

function asReservationStage(
  value: string,
): InvestorReservationRecord["reservationStage"] {
  if (
    value === "initiated" ||
    value === "awaiting_reconfirmation" ||
    value === "reconfirmed" ||
    value === "finalized" ||
    value === "cancelled" ||
    value === "lapsed"
  ) {
    return value;
  }
  throw new Error(`Unknown reservation stage: ${value}`);
}

function asOfferingStatus(
  value: string,
): InvestorReservationRecord["offeringStatus"] {
  if (value === "pre_offering" || value === "final_offering" || value === "closed") {
    return value;
  }
  throw new Error(`Unknown offering status: ${value}`);
}

function asCapitalState(
  value: string,
): NonNullable<InvestorReservationRecord["latestMoneyEvent"]>["capitalState"] {
  if (
    value === "initiated" ||
    value === "eurc_purchase_pending" ||
    value === "purchase_failed" ||
    value === "eurc_reserved" ||
    value === "reconfirmation_pending" ||
    value === "eurc_finalized" ||
    value === "provider_disputed"
  ) {
    return value;
  }
  throw new Error(`Unknown capital state: ${value}`);
}

function asCurrentPositionStatus(
  value: string,
): InvestorPositionRecord["positionStatus"] {
  if (value === "pending_internal_settlement" || value === "active") return value;
  throw new Error(`Unknown current position status: ${value}`);
}

function toPropertySummary(input: {
  propertyType: string;
  countryCode: string;
  city: string | null;
}): InvestorPropertySummary {
  if (input.propertyType !== "residential") {
    throw new Error(`Unknown property type: ${input.propertyType}`);
  }
  return {
    propertyType: input.propertyType,
    countryCode: input.countryCode,
    city: input.city,
  };
}
