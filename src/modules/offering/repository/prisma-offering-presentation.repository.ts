import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { toOfferingMedia, type OfferingMedia } from "../domain/offering-media.policy.js";
import type {
  OfferingPresentation,
  OfferingPresentationRepository,
  UpdateOfferingPresentationInput,
} from "./offering-presentation.repository.js";

export class PrismaOfferingPresentationRepository implements OfferingPresentationRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async updatePresentation(input: UpdateOfferingPresentationInput): Promise<OfferingPresentation | null> {
    return this.database.$transaction(async (transaction) => {
      // Lock the row so the audit row's `before` is the state this update replaced.
      const rows = await transaction.$queryRaw<
        Array<{ featured: boolean; hero_image_url: string | null; gallery_image_urls: string[] }>
      >`
        SELECT featured, hero_image_url, gallery_image_urls
        FROM offering.offerings
        WHERE offering_id = ${input.offeringId}
        FOR UPDATE
      `;
      const current = rows[0];
      if (current === undefined) return null;

      const before: OfferingPresentation = {
        featured: current.featured,
        media: toOfferingMedia(current.hero_image_url, current.gallery_image_urls),
      };
      const after: OfferingPresentation = {
        featured: input.featured ?? before.featured,
        media: input.media === undefined ? before.media : normalize(input.media),
      };

      await transaction.offering.update({
        where: { id: input.offeringId },
        data: {
          featured: after.featured,
          heroImageUrl: after.media?.heroUrl ?? null,
          galleryImageUrls: after.media?.galleryUrls ?? [],
        },
      });
      await transaction.auditLog.create({
        data: {
          id: `audit_${ulid()}`,
          actorAccountId: input.actorAccountId,
          action: "offering.presentation_updated",
          resourceType: "offering",
          resourceId: input.offeringId,
          changes: {
            trace_id: input.traceId,
            before: toAuditValue(before),
            after: toAuditValue(after),
          },
          createdAt: input.updatedAt,
        },
      });
      return after;
    });
  }
}

function normalize(media: OfferingMedia | null): OfferingMedia | null {
  return media === null ? null : toOfferingMedia(media.heroUrl, media.galleryUrls);
}

function toAuditValue(presentation: OfferingPresentation) {
  return {
    featured: presentation.featured,
    media:
      presentation.media === null
        ? null
        : { hero_url: presentation.media.heroUrl, gallery_urls: presentation.media.galleryUrls },
  };
}
