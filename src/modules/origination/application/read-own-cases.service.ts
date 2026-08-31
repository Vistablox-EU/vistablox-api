import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  ListOwnCasesQuery,
  OwnedCaseResponse,
} from "../api/origination.schemas.js";
import { originationCaseStageSchema } from "../api/origination.schemas.js";
import type {
  OriginationCaseCursor,
  OriginationRepository,
  OwnedOriginationCase,
} from "../repository/origination.repository.js";

const cursorSchema = z.object({ created_at: z.iso.datetime(), id: z.string().min(1) });

export class ListOwnCasesService {
  public constructor(private readonly repository: OriginationRepository) {}

  public async execute(input: {
    accountId: string;
    query: ListOwnCasesQuery;
  }): Promise<{ data: OwnedCaseResponse[]; page: { next_cursor: string | null } }> {
    const after = input.query.after === undefined ? undefined : decodeCaseCursor(input.query.after);
    const rows = await this.repository.listOwnedCases({
      accountId: input.accountId,
      limit: input.query.limit + 1,
      ...(after === undefined ? {} : { after }),
    });
    const hasNextPage = rows.length > input.query.limit;
    const pageRows = hasNextPage ? rows.slice(0, input.query.limit) : rows;
    const last = pageRows.at(-1);

    return {
      data: pageRows.map(toOwnedCaseResponse),
      page: {
        next_cursor:
          hasNextPage && last !== undefined
            ? encodeCaseCursor({ createdAt: last.createdAt, id: last.caseId })
            : null,
      },
    };
  }
}

export class GetOwnCaseService {
  public constructor(private readonly repository: OriginationRepository) {}

  public async execute(accountId: string, caseId: string): Promise<OwnedCaseResponse> {
    const originationCase = await this.repository.getOwnedCase(accountId, caseId);
    if (originationCase === null) {
      throw new AppError({
        code: "origination.case_not_found",
        title: "Origination case not found",
        status: 404,
        detail: "The requested origination case was not found.",
      });
    }
    return toOwnedCaseResponse(originationCase);
  }
}

export function toOwnedCaseResponse(input: OwnedOriginationCase): OwnedCaseResponse {
  return {
    case_id: input.caseId,
    stage: originationCaseStageSchema.parse(input.stage),
    created_at: input.createdAt.toISOString(),
    updated_at: input.updatedAt.toISOString(),
    current_revision:
      input.currentRevision === null
        ? null
        : {
            revision_number: input.currentRevision.revisionNumber,
            submitted_at: input.currentRevision.submittedAt.toISOString(),
          },
    property: {
      property_id: input.property.propertyId,
      property_type: "residential",
      country_code: input.property.countryCode,
      city: input.property.city,
      address_line: input.property.addressLine,
      land_registry_reference: input.property.landRegistryReference,
      owner_declared_value_eur: input.property.ownerDeclaredValueEur,
      has_existing_encumbrance: input.property.hasExistingEncumbrance,
    },
  };
}

export function encodeCaseCursor(cursor: OriginationCaseCursor): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.createdAt.toISOString(), id: cursor.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCaseCursor(value: string): OriginationCaseCursor {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
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
