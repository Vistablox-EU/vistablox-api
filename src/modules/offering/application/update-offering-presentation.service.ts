import { AppError } from "../../../shared/errors/app-error.js";
import type {
  UpdateOfferingPresentationBody,
  UpdateOfferingPresentationResponse,
} from "../api/offering-operations.schemas.js";
import type { OfferingPresentationRepository } from "../repository/offering-presentation.repository.js";

/**
 * #180: admin_operations sets what the investor offering list and detail
 * show — the featured flag (featured offerings sort first) and the media
 * (hero image + gallery, externally hosted HTTPS URLs). Neither touches
 * offering terms, so it is allowed in every offering status and is not a
 * materiality event. Every change is audit-logged with before and after.
 */
export class UpdateOfferingPresentationService {
  public constructor(
    private readonly repository: OfferingPresentationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    offeringId: string;
    traceId: string;
    body: UpdateOfferingPresentationBody;
  }): Promise<UpdateOfferingPresentationResponse> {
    const media = input.body.media;
    const updated = await this.repository.updatePresentation({
      offeringId: input.offeringId,
      ...(input.body.featured === undefined ? {} : { featured: input.body.featured }),
      ...(media === undefined
        ? {}
        : { media: media === null ? null : { heroUrl: media.hero_url, galleryUrls: media.gallery_urls } }),
      actorAccountId: input.accountId,
      traceId: input.traceId,
      updatedAt: this.clock(),
    });

    if (updated === null) {
      throw new AppError({
        code: "offering.not_found",
        title: "Offering not found",
        status: 404,
        detail: "The requested offering does not exist.",
      });
    }

    return {
      data: {
        offering_id: input.offeringId,
        featured: updated.featured,
        media:
          updated.media === null
            ? null
            : { hero_url: updated.media.heroUrl, gallery_urls: updated.media.galleryUrls },
      },
    };
  }
}
