import type { Logger } from "pino";

import { investorImageUrl } from "../api/offering.schemas.js";
import {
  MAX_OFFERING_GALLERY_IMAGES,
  MAX_OFFERING_MEDIA_URL_LENGTH,
  toOfferingMedia,
  type OfferingMedia,
} from "../domain/offering-media.policy.js";

/**
 * Read-path guard for stored offering media. The database does not constrain
 * these columns, so a restore or manual SQL can leave a value the response
 * schemas reject, and one such row would fail a whole public page. Invalid
 * entries are dropped (a bad hero becomes null, a bad gallery entry is
 * removed) and logged with the offering id so staff can fix the row.
 */
export function sanitizeOfferingMedia(
  offeringId: string,
  media: OfferingMedia | null,
  logger?: Logger,
): OfferingMedia | null {
  if (media === null) return null;

  const heroUrl = media.heroUrl !== null && isServableUrl(media.heroUrl) ? media.heroUrl : null;
  const validGallery = media.galleryUrls.filter(isServableUrl);
  const galleryUrls = validGallery.slice(0, MAX_OFFERING_GALLERY_IMAGES);
  const droppedHero = media.heroUrl !== null && heroUrl === null;
  const droppedGalleryEntries = media.galleryUrls.length - galleryUrls.length;

  if (droppedHero || droppedGalleryEntries > 0) {
    logger?.warn(
      { offering_id: offeringId, dropped_hero: droppedHero, dropped_gallery_entries: droppedGalleryEntries },
      "Stored offering media has invalid URLs; they were left out of the response",
    );
  }
  return toOfferingMedia(heroUrl, galleryUrls);
}

function isServableUrl(value: string): boolean {
  return value.length <= MAX_OFFERING_MEDIA_URL_LENGTH && investorImageUrl.safeParse(value).success;
}
