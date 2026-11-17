/**
 * Investor-facing offering media (#180): an optional hero image and an
 * ordered gallery, both externally hosted HTTPS URLs. The platform never
 * serves these from MinIO, which must never be reachable from a public URL.
 */
export const MAX_OFFERING_GALLERY_IMAGES = 20;
export const MAX_OFFERING_MEDIA_URL_LENGTH = 2048;

export interface OfferingMedia {
  heroUrl: string | null;
  galleryUrls: string[];
}

/** No hero and an empty gallery is "no media", which the wire shows as `null`. */
export function toOfferingMedia(heroImageUrl: string | null, galleryImageUrls: readonly string[]): OfferingMedia | null {
  if (heroImageUrl === null && galleryImageUrls.length === 0) return null;
  return { heroUrl: heroImageUrl, galleryUrls: [...galleryImageUrls] };
}
