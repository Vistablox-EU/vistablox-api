import type { DisclosureDocumentType } from "../domain/disclosure-pack.policy.js";

export interface PublishDisclosurePackDocumentInput {
  documentType: DisclosureDocumentType;
  documentRef: string;
}

export interface PublishDisclosurePackInput {
  offeringId: string;
  accountId: string;
  documents: PublishDisclosurePackDocumentInput[];
  traceId: string;
  publishedAt: Date;
}

export interface PublishedDisclosurePackDocument {
  documentId: string;
  documentType: DisclosureDocumentType;
  documentRef: string;
  isCoreReading: boolean;
}

export interface PublishedDisclosurePack {
  disclosurePackId: string;
  offeringId: string;
  version: number;
  publishedAt: Date;
  documents: PublishedDisclosurePackDocument[];
  isComplete: boolean;
  supersededPackId: string | null;
}

export type PublishDisclosurePackConflict = "offering_not_found" | "not_open";

export interface PublishDisclosurePackResult {
  published: PublishedDisclosurePack | null;
  conflict: PublishDisclosurePackConflict | null;
}

/**
 * One reusable staff primitive rather than logic wired into any single
 * flow — the docs (AD-037, VISTABLOX_BACKEND_DISCUSSION.md) describe at
 * least three distinct moments a pack gets (re)published: an initial
 * pre-offering pack (whatever hasDisclosurePack/disclosure_pack_unavailable
 * already gates ordinary reservation creation on), the version-locked
 * pack tied to final_offering_published_at (AD-037), and a republished
 * pack after a materiality reset (AD-038's "always resets the disclosure
 * pack" — still not built as a side effect of classifyMateriality; calling
 * this method separately is how that gap gets closed later). All three are
 * the same mechanical action: create a new version, supersede the old one.
 *
 * Only accepted while the offering is still pre_offering (the same window
 * publishFinalOfferingTerms/classifyMateriality/reconfirmReservation
 * already operate in) — AD-046 puts post-finalization content changes
 * through a separate amendment/consent path this codebase does not build.
 *
 * document_ref is a trusted, already-uploaded storage reference, the same
 * shape origination's own document intake already uses
 * (submissionDocumentTypeSchema/document_ref) — this codebase has no file
 * upload path for any document kind, disclosure documents included; the
 * underlying file reaching storage is a process this API does not perform.
 */
export interface DisclosurePackRepository {
  publishDisclosurePack(input: PublishDisclosurePackInput): Promise<PublishDisclosurePackResult>;
}
