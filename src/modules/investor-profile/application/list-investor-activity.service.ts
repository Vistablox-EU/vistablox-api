import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type { InvestorActivityQuery } from "../api/investor-profile.schemas.js";
import type {
  InvestorPositionCursor,
  InvestorProfileRepository,
  InvestorReservationCursor,
} from "../repository/investor-profile.repository.js";

const reservationCursorSchema = z.object({
  kind: z.literal("investor_reservations"),
  created_at: z.iso.datetime(),
  id: z.string().min(1),
});

const positionCursorSchema = z.object({
  kind: z.literal("investor_positions"),
  activated_at: z.iso.datetime().nullable(),
  id: z.string().min(1),
});

export class ListInvestorReservationsService {
  public constructor(private readonly repository: InvestorProfileRepository) {}

  public async execute(input: {
    accountId: string;
    query: InvestorActivityQuery;
  }) {
    const after =
      input.query.after === undefined
        ? undefined
        : decodeReservationCursor(input.query.after);
    const rows = await this.repository.listReservations({
      accountId: input.accountId,
      limit: input.query.limit + 1,
      ...(after === undefined ? {} : { after }),
    });
    const hasNextPage = rows.length > input.query.limit;
    const pageRows = hasNextPage ? rows.slice(0, input.query.limit) : rows;
    const last = pageRows.at(-1);

    return {
      data: pageRows.map((row) => ({
        reservation_id: row.reservationId,
        offering_id: row.offeringId,
        offering_status: row.offeringStatus,
        amount_eur: row.amountEur,
        reservation_stage: row.reservationStage,
        disclosure_pack_version_at_reservation:
          row.disclosurePackVersionAtReservation,
        reconfirmed_at: row.reconfirmedAt?.toISOString() ?? null,
        reservation_finalized_at:
          row.reservationFinalizedAt?.toISOString() ?? null,
        created_at: row.createdAt.toISOString(),
        latest_capital_state:
          row.latestMoneyEvent === null
            ? null
            : {
                state: row.latestMoneyEvent.capitalState,
                amount_eur: row.latestMoneyEvent.amountEur,
                amount_eurc: row.latestMoneyEvent.amountEurc,
                recorded_at: row.latestMoneyEvent.recordedAt.toISOString(),
              },
        property: {
          property_type: row.property.propertyType,
          country_code: row.property.countryCode,
          city: row.property.city,
        },
      })),
      page: {
        next_cursor:
          hasNextPage && last !== undefined
            ? encodeReservationCursor({
                createdAt: last.createdAt,
                id: last.reservationId,
              })
            : null,
      },
    };
  }
}

export class ListInvestorCurrentPositionsService {
  public constructor(private readonly repository: InvestorProfileRepository) {}

  public async execute(input: {
    accountId: string;
    query: InvestorActivityQuery;
  }) {
    const after =
      input.query.after === undefined
        ? undefined
        : decodePositionCursor(input.query.after);
    const rows = await this.repository.listCurrentPositions({
      accountId: input.accountId,
      limit: input.query.limit + 1,
      ...(after === undefined ? {} : { after }),
    });
    const hasNextPage = rows.length > input.query.limit;
    const pageRows = hasNextPage ? rows.slice(0, input.query.limit) : rows;
    const last = pageRows.at(-1);

    return {
      data: pageRows.map((row) => ({
        position_id: row.positionId,
        reservation_id: row.reservationId,
        offering_id: row.offeringId,
        piv_id: row.pivId,
        unit_count: row.unitCount,
        cost_basis_eur: row.costBasisEur,
        position_status: row.positionStatus,
        activated_at: row.activatedAt?.toISOString() ?? null,
        property: {
          property_type: row.property.propertyType,
          country_code: row.property.countryCode,
          city: row.property.city,
        },
      })),
      page: {
        next_cursor:
          hasNextPage && last !== undefined
            ? encodePositionCursor({
                activatedAt: last.activatedAt,
                id: last.positionId,
              })
            : null,
      },
    };
  }
}

export function encodeReservationCursor(cursor: InvestorReservationCursor): string {
  return encode({
    kind: "investor_reservations",
    created_at: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}

export function decodeReservationCursor(value: string): InvestorReservationCursor {
  const parsed = decode(value, reservationCursorSchema);
  return { createdAt: new Date(parsed.created_at), id: parsed.id };
}

export function encodePositionCursor(cursor: InvestorPositionCursor): string {
  return encode({
    kind: "investor_positions",
    activated_at: cursor.activatedAt?.toISOString() ?? null,
    id: cursor.id,
  });
}

export function decodePositionCursor(value: string): InvestorPositionCursor {
  const parsed = decode(value, positionCursorSchema);
  return {
    activatedAt:
      parsed.activated_at === null ? null : new Date(parsed.activated_at),
    id: parsed.id,
  };
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<Schema extends z.ZodType>(
  value: string,
  schema: Schema,
): z.infer<Schema> {
  try {
    return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch (cause) {
    throw new AppError({
      code: "pagination.invalid_cursor",
      title: "Invalid pagination cursor",
      status: 422,
      detail: "The supplied pagination cursor is invalid or expired.",
      fieldErrors: [
        { field: "after", code: "cursor.invalid", message: "Invalid cursor." },
      ],
      cause,
    });
  }
}
