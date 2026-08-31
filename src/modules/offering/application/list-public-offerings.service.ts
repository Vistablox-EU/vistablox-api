import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type { ListOfferingsQuery, ListOfferingsResponse } from "../api/offering.schemas.js";
import type { OfferingCursor, OfferingRepository } from "../repository/offering.repository.js";

const cursorPayloadSchema = z.object({
  created_at: z.iso.datetime(),
  id: z.string().min(1),
});

export class ListPublicOfferingsService {
  public constructor(private readonly repository: OfferingRepository) {}

  public async execute(query: ListOfferingsQuery): Promise<ListOfferingsResponse> {
    const after = query.after === undefined ? undefined : decodeCursor(query.after);
    const rows = await this.repository.listPublic({
      limit: query.limit + 1,
      ...(after === undefined ? {} : { after }),
    });
    const hasNextPage = rows.length > query.limit;
    const pageRows = hasNextPage ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);

    return {
      data: pageRows.map((row) => ({
        id: row.id,
        status: row.status,
        target_raise_eur: row.targetRaiseEur,
        ipo_end_at: row.ipoEndAt?.toISOString() ?? null,
        property: {
          property_type: row.property.propertyType,
          country_code: row.property.countryCode,
          city: row.property.city,
        },
      })),
      page: {
        next_cursor: hasNextPage && last !== undefined
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
      },
    };
  }
}

function encodeCursor(cursor: OfferingCursor): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.createdAt.toISOString(), id: cursor.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string): OfferingCursor {
  try {
    const parsed = cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return { createdAt: new Date(parsed.created_at), id: parsed.id };
  } catch (cause) {
    throw new AppError({
      code: "pagination.invalid_cursor",
      title: "Invalid pagination cursor",
      status: 422,
      detail: "The supplied pagination cursor is invalid or expired.",
      fieldErrors: [{ field: "after", code: "cursor.invalid", message: "Invalid cursor." }],
      cause,
    });
  }
}
