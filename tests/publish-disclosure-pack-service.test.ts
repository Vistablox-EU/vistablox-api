import { describe, expect, it, vi } from "vitest";

import { PublishDisclosurePackService } from "../src/modules/offering/application/publish-disclosure-pack.service.js";
import type {
  DisclosurePackRepository,
  PublishDisclosurePackInput,
  PublishDisclosurePackResult,
} from "../src/modules/offering/repository/disclosure-pack.repository.js";

const now = new Date("2026-09-06T12:00:00.000Z");

function repository(overrides: Partial<DisclosurePackRepository> = {}): DisclosurePackRepository {
  return {
    publishDisclosurePack: vi.fn(
      async (input: PublishDisclosurePackInput): Promise<PublishDisclosurePackResult> => ({
        published: {
          disclosurePackId: "pack_01",
          offeringId: input.offeringId,
          version: 1,
          publishedAt: input.publishedAt,
          documents: input.documents.map((document, index) => ({
            documentId: `document_0${index + 1}`,
            documentType: document.documentType,
            documentRef: document.documentRef,
            isCoreReading: document.documentType !== "full_prospectus",
          })),
          isComplete: false,
          supersededPackId: null,
        },
        conflict: null,
      }),
    ),
    ...overrides,
  };
}

describe("PublishDisclosurePackService", () => {
  it("publishes a pack and reports the outcome", async () => {
    const publishDisclosurePack = vi.fn().mockResolvedValue({
      published: {
        disclosurePackId: "pack_01",
        offeringId: "offering_01",
        version: 2,
        publishedAt: now,
        documents: [
          { documentId: "document_01", documentType: "ecsp_kiis", documentRef: "documents/kiis-v2.pdf", isCoreReading: true },
        ],
        isComplete: false,
        supersededPackId: "pack_00",
      },
      conflict: null,
    });
    const service = new PublishDisclosurePackService(repository({ publishDisclosurePack }), () => now);

    const result = await service.execute({
      accountId: "account_staff",
      offeringId: "offering_01",
      traceId: "req_01",
      body: { documents: [{ document_type: "ecsp_kiis", document_ref: "documents/kiis-v2.pdf" }] },
    });

    expect(result).toEqual({
      data: {
        disclosure_pack_id: "pack_01",
        offering_id: "offering_01",
        version: 2,
        published_at: now.toISOString(),
        documents: [{ document_id: "document_01", document_type: "ecsp_kiis", is_core_reading: true }],
        is_complete: false,
        superseded_pack_id: "pack_00",
      },
    });
    expect(publishDisclosurePack).toHaveBeenCalledWith({
      offeringId: "offering_01",
      accountId: "account_staff",
      documents: [{ documentType: "ecsp_kiis", documentRef: "documents/kiis-v2.pdf" }],
      traceId: "req_01",
      publishedAt: now,
    });
  });

  it("404s when the offering does not exist", async () => {
    const service = new PublishDisclosurePackService(
      repository({
        publishDisclosurePack: vi.fn().mockResolvedValue({ published: null, conflict: "offering_not_found" }),
      }),
      () => now,
    );

    await expect(
      service.execute({
        accountId: "account_staff",
        offeringId: "offering_missing",
        traceId: "req_01",
        body: { documents: [{ document_type: "ecsp_kiis", document_ref: "documents/kiis-v1.pdf" }] },
      }),
    ).rejects.toMatchObject({ code: "offering.not_found", status: 404 });
  });

  it("reports a 409 when the offering is not open for a disclosure pack update", async () => {
    const service = new PublishDisclosurePackService(
      repository({
        publishDisclosurePack: vi.fn().mockResolvedValue({ published: null, conflict: "not_open" }),
      }),
      () => now,
    );

    await expect(
      service.execute({
        accountId: "account_staff",
        offeringId: "offering_01",
        traceId: "req_01",
        body: { documents: [{ document_type: "ecsp_kiis", document_ref: "documents/kiis-v1.pdf" }] },
      }),
    ).rejects.toMatchObject({ code: "offering.disclosure_pack_not_available", status: 409 });
  });
});
