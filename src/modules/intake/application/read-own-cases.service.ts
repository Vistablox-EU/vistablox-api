import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type {
  ListOwnCasesQuery,
  OwnedCaseResponse,
} from "../api/intake.schemas.js";
import {
  energyRatingSchema,
  intakeCaseStageSchema,
  propertyConditionSchema,
  residentialSubtypeSchema,
  roomTypeSchema,
} from "../api/intake.schemas.js";
import type {
  IntakeCaseCursor,
  IntakeRepository,
  OwnedIntakeCase,
} from "../repository/intake.repository.js";
import {
  displayLabel,
  intakePropertyConditionLabels,
  intakeEnergyRatingLabels,
  intakeResidentialSubtypeLabels,
  intakeRoomTypeLabels,
  intakeStageLabels,
} from "../presentation/intake-labels.js";

const cursorSchema = z.object({ created_at: z.iso.datetime(), id: z.string().min(1) });

export class ListOwnCasesService {
  public constructor(private readonly repository: IntakeRepository) {}

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
  public constructor(private readonly repository: IntakeRepository) {}

  public async execute(accountId: string, caseId: string): Promise<OwnedCaseResponse> {
    const intakeCase = await this.repository.getOwnedCase(accountId, caseId);
    if (intakeCase === null) {
      throw new AppError({
        code: "intake.case_not_found",
        title: "Intake case not found",
        status: 404,
        detail: "The requested intake case was not found.",
      });
    }
    return toOwnedCaseResponse(intakeCase);
  }
}

export function toOwnedCaseResponse(input: OwnedIntakeCase): OwnedCaseResponse {
  return {
    case_id: input.caseId,
    stage: intakeCaseStageSchema.parse(input.stage),
    stage_label: displayLabel(input.stage, intakeStageLabels)!,
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
      residential_subtype:
        input.property.residentialSubtype === null
          ? null
          : residentialSubtypeSchema.parse(input.property.residentialSubtype),
      residential_subtype_label: displayLabel(input.property.residentialSubtype, intakeResidentialSubtypeLabels),
      living_area_sq_m: input.property.livingAreaSqM,
      bedrooms: input.property.bedrooms,
      bathrooms: input.property.bathrooms,
      floor: input.property.floor,
      total_floors: input.property.totalFloors,
      year_built: input.property.yearBuilt,
      condition:
        input.property.condition === null
          ? null
          : propertyConditionSchema.parse(input.property.condition),
      condition_label: displayLabel(input.property.condition, intakePropertyConditionLabels),
      energy_rating:
        input.property.energyRating === null
          ? null
          : energyRatingSchema.parse(input.property.energyRating),
      energy_rating_label: displayLabel(input.property.energyRating, intakeEnergyRatingLabels),
      rooms: input.property.rooms.map((room) => ({
        room_id: room.roomId,
        room_type: roomTypeSchema.parse(room.roomType),
        room_type_label: displayLabel(room.roomType, intakeRoomTypeLabels)!,
        size_sq_m: room.sizeSqM,
        preferred_photo_id: room.preferredPhotoId ?? null,
        representative_photo_id: chooseRepresentativePhoto(room),
        photos: (room.photos ?? []).map((photo) => ({
          document_id: photo.documentId,
          document_ref: photo.documentRef,
          thumbnail_ref: photo.thumbnailRef ?? null,
          content_type: photo.contentType,
          uploaded_at: photo.uploadedAt.toISOString(),
        })),
      })),
    },
  };
}

function chooseRepresentativePhoto(room: { preferredPhotoId?: string | null; photos?: Array<{ documentId: string }> }): string | null {
  const photos = room.photos ?? [];
  const preferred = photos.find((photo) => photo.documentId === room.preferredPhotoId);
  return preferred?.documentId ?? photos[0]?.documentId ?? null;
}

export function encodeCaseCursor(cursor: IntakeCaseCursor): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.createdAt.toISOString(), id: cursor.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeCaseCursor(value: string): IntakeCaseCursor {
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
