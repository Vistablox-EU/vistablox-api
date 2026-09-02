import { AppError } from "../../../shared/errors/app-error.js";
import type {
  PublishDisclosurePackBody,
  PublishDisclosurePackResponse,
} from "../api/offering-operations.schemas.js";
import type { DisclosurePackRepository } from "../repository/disclosure-pack.repository.js";

/**
 * Staff-triggered (admin_operations), reusable at any of the moments the
 * documented flow implies a new disclosure-pack version is needed: an
 * initial pre-offering pack, the version-locked pack tied to
 * final_offering_published_at (AD-037), or a republish after a materiality
 * reset (AD-038) — see docs/investor-offering.md for the full picture and
 * the reconfirmReservation-completeness gate this deliberately does not
 * also build.
 */
export class PublishDisclosurePackService {
  public constructor(
    private readonly repository: DisclosurePackRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    offeringId: string;
    traceId: string;
    body: PublishDisclosurePackBody;
  }): Promise<PublishDisclosurePackResponse> {
    const result = await this.repository.publishDisclosurePack({
      offeringId: input.offeringId,
      accountId: input.accountId,
      documents: input.body.documents.map((document) => ({
        documentType: document.document_type,
        documentRef: document.document_ref,
      })),
      traceId: input.traceId,
      publishedAt: this.clock(),
    });

    if (result.conflict === "offering_not_found") {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }
    if (result.conflict === "not_open") {
      throw new AppError({
        code: "offering.disclosure_pack_not_available",
        title: "Disclosure pack cannot be published",
        status: 409,
        detail: "This offering is not currently open for a disclosure pack update.",
      });
    }

    const published = result.published;
    if (published === null) {
      throw new AppError({
        code: "internal.unexpected",
        title: "Internal server error",
        status: 500,
        detail: "Publishing a disclosure pack returned neither a result nor a conflict.",
      });
    }

    return {
      data: {
        disclosure_pack_id: published.disclosurePackId,
        offering_id: published.offeringId,
        version: published.version,
        published_at: published.publishedAt.toISOString(),
        documents: published.documents.map((document) => ({
          document_id: document.documentId,
          document_type: document.documentType,
          is_core_reading: document.isCoreReading,
        })),
        is_complete: published.isComplete,
        superseded_pack_id: published.supersededPackId,
      },
    };
  }
}
