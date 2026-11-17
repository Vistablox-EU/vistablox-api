import type { OfferingMedia } from "../domain/offering-media.policy.js";

export interface OfferingPresentation {
  featured: boolean;
  media: OfferingMedia | null;
}

export interface UpdateOfferingPresentationInput {
  offeringId: string;
  /** Undefined leaves the flag as it is. */
  featured?: boolean;
  /** Undefined leaves the media as they are; null clears them. */
  media?: OfferingMedia | null;
  actorAccountId: string;
  traceId: string;
  updatedAt: Date;
}

export interface OfferingPresentationRepository {
  /** Returns the stored presentation after the update, or null when the offering does not exist. */
  updatePresentation(input: UpdateOfferingPresentationInput): Promise<OfferingPresentation | null>;
}
