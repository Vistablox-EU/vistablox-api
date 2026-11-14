import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import express, { type RequestHandler } from "express";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma.js";
import type { MalwareScanner } from "../src/infrastructure/antivirus/clamav-scanner.js";
import { createOfferingOperationsRouter } from "../src/modules/offering/api/offering-operations.router.js";
import { createInvestorOfferingRouter } from "../src/modules/offering/api/offering.router.js";
import { ClassifyMaterialityService } from "../src/modules/offering/application/classify-materiality.service.js";
import type {
  DisclosureDocumentUpload,
  StoredDisclosureDocument,
  WritableDisclosureDocumentStore,
} from "../src/modules/offering/application/disclosure-document-store.js";
import { DownloadDisclosureDocumentService } from "../src/modules/offering/application/download-disclosure-document.service.js";
import { FinalizeOfferingService } from "../src/modules/offering/application/finalize-offering.service.js";
import { GetInvestorOfferingService } from "../src/modules/offering/application/get-investor-offering.service.js";
import { GetOfferingDocumentService } from "../src/modules/offering/application/get-offering-document.service.js";
import { PublishDisclosurePackService } from "../src/modules/offering/application/publish-disclosure-pack.service.js";
import { UploadOfferingDocumentService } from "../src/modules/offering/application/upload-offering-document.service.js";
import { PrismaOfferingDocumentRepository } from "../src/modules/offering/repository/prisma-offering-document.repository.js";
import { PrismaOfferingRepository } from "../src/modules/offering/repository/prisma-offering.repository.js";
import { PrismaKycRepository } from "../src/modules/identity/repository/prisma-kyc.repository.js";
import { errorHandler } from "../src/shared/http/error-handler.js";
import { requestContext } from "../src/shared/http/request-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

/**
 * Stands in for the disclosures bucket. The point of this suite is the
 * database side of the contract — the row the upload writes is the row the
 * publish validates against and the row the investor download resolves — so
 * the object store is an in-memory map shared by every route the way one
 * MinIO bucket is in production. The MinIO adapter itself is covered by
 * minio-disclosure-document-store.integration.test.ts.
 */
class MemoryDisclosureDocumentStore implements WritableDisclosureDocumentStore {
  public readonly objects = new Map<string, DisclosureDocumentUpload>();

  public async get(documentReference: string): Promise<StoredDisclosureDocument | null> {
    const object = this.objects.get(documentReference);
    if (object === undefined) return null;
    return {
      body: Readable.from(object.body),
      contentType: object.contentType,
      contentLength: object.body.length,
      fileName: object.metadata["original-filename"] ?? null,
    };
  }

  public async put(input: DisclosureDocumentUpload): Promise<void> {
    this.objects.set(input.documentReference, { ...input, body: Buffer.from(input.body) });
  }

  public async delete(documentReference: string): Promise<void> {
    this.objects.delete(documentReference);
  }
}

function rawBody(): Parameters<request.Test["parse"]>[0] {
  return (message, callback) => {
    const chunks: Buffer[] = [];
    message.on("data", (chunk: Buffer) => chunks.push(chunk));
    message.on("end", () => callback(null, Buffer.concat(chunks)));
  };
}

describe.skipIf(databaseUrl === undefined)("offering disclosure-document upload PostgreSQL integration", () => {
  const suffix = randomUUID();
  const staffAccountId = `account_staff_${suffix}`;
  const investorAccountId = `account_investor_${suffix}`;
  const propertyId = `property_${suffix}`;
  const caseId = `case_${suffix}`;
  const pivId = `piv_${suffix}`;
  // Upper-case ULID-shaped, like a real offering id, so the object key the
  // upload derives from it is exercised with the characters it will see.
  const offeringId = `offering_01M7AGKPB4F22YKF7Y3S${suffix.slice(0, 6).toUpperCase().replaceAll("-", "A")}`;
  const bucket = `vistablox-disclosures-${suffix}`;
  const authPool = new Pool({ connectionString: databaseUrl });
  const database = createPrismaClient(databaseUrl ?? "");
  const store = new MemoryDisclosureDocumentStore();
  let scanResult: "clean" | "infected" | "down" = "clean";
  const scanner: MalwareScanner = {
    scan: async () => {
      if (scanResult === "down") throw new Error("clamd unreachable");
      return scanResult;
    },
  };
  let boss: PgBoss;
  let app: express.Express;

  const pdf = Buffer.from("%PDF-1.4\n% final terms sheet, version 1\n%%EOF\n");

  beforeAll(async () => {
    boss = new PgBoss(databaseUrl ?? "");
    const offeringRepository = new PrismaOfferingRepository(database, boss, new PrismaKycRepository(database, boss), {
      disclosuresBucket: bucket,
    });
    const documentRepository = new PrismaOfferingDocumentRepository(database, bucket);

    for (const [accountId, population] of [
      [staffAccountId, "staff_partner"],
      [investorAccountId, "customer"],
    ] as const) {
      await authPool.query(
        'INSERT INTO "auth_user" ("id", "name", "email", "emailVerified", "population") VALUES ($1, $2, $3, $4, $5)',
        [`auth_${accountId}`, "Upload Test", `${accountId}@example.test`, true, population],
      );
      await database.account.create({ data: { id: accountId, betterAuthUserId: `auth_${accountId}` } });
    }
    await database.property.create({
      data: { id: propertyId, countryCode: "RS", city: "Belgrade", addressLine: "Upload Test 1", ownerDeclaredValueEur: "300000.00" },
    });
    await database.intakeCase.create({
      data: {
        id: caseId,
        propertyId,
        applicantAccountId: investorAccountId,
        stage: "approved_for_final_offering",
        legalExecutionEventRefs: [],
        legalDocumentRefs: [],
        appraisalDocumentRefs: [],
      },
    });
    await database.piv.create({ data: { id: pivId, propertyId, caseId } });
    await database.offering.create({
      data: { id: offeringId, pivId, minimumRaiseEur: "1000.00", targetRaiseEur: "1000.00", status: "pre_offering" },
    });

    const staff: RequestHandler = (_request, response, next) => {
      response.locals.authContext = { accountId: staffAccountId, providerSessionId: "session_staff", population: "staff_partner" };
      next();
    };
    const investor: RequestHandler = (_request, response, next) => {
      response.locals.authContext = { accountId: investorAccountId, providerSessionId: "session_investor", population: "customer" };
      next();
    };
    const passThrough: RequestHandler = (_request, _response, next) => next();

    app = express();
    app.use(requestContext);
    app.use(express.json({ type: "application/json" }));
    app.use(
      "/internal/v1/offerings",
      createOfferingOperationsRouter(
        staff,
        passThrough,
        passThrough,
        new FinalizeOfferingService(offeringRepository),
        new ClassifyMaterialityService(offeringRepository),
        new PublishDisclosurePackService(offeringRepository),
        undefined,
        {
          upload: new UploadOfferingDocumentService(documentRepository, store, scanner),
          read: new GetOfferingDocumentService(documentRepository, store),
        },
      ),
    );
    app.use(
      "/v1/offerings",
      createInvestorOfferingRouter(
        investor,
        new GetInvestorOfferingService(offeringRepository),
        new DownloadDisclosureDocumentService(offeringRepository, store),
      ),
    );
    app.use(errorHandler);
  }, 30_000);

  afterAll(async () => {
    await database.disclosureDocument.deleteMany({ where: { disclosurePack: { offeringId } } });
    await database.disclosurePack.deleteMany({ where: { offeringId } });
    await database.storedDocument.deleteMany({ where: { offeringId } });
    await database.auditLog.deleteMany({ where: { OR: [{ resourceId: offeringId }, { actorAccountId: staffAccountId }] } });
    await database.offering.deleteMany({ where: { id: offeringId } });
    await database.piv.deleteMany({ where: { id: pivId } });
    // The intake case, property, accounts and auth_user rows carry a per-run
    // suffix and are left in place, as the other offering suites do.
    await Promise.all([database.$disconnect(), authPool.end()]);
  });

  let documentRef = "";
  let documentId = "";

  it("uploads a disclosure document: scanned, stored under the offering's key, recorded and audited", async () => {
    const response = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/documents`)
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "final_terms_sheet")
      .set("X-Original-Filename", encodeURIComponent("Završni uslovi – v1.pdf"))
      .send(pdf);

    expect(response.status).toBe(201);
    const checksum = createHash("sha256").update(pdf).digest("hex");
    expect(response.body).toEqual({
      data: {
        document_id: expect.stringMatching(/^doc_[a-f0-9]{32}$/),
        document_type: "final_terms_sheet",
        document_ref: expect.stringMatching(new RegExp(`^offerings/${offeringId}/doc_[a-f0-9]{32}$`)),
        content_type: "application/pdf",
        size_bytes: pdf.length,
        sha256_checksum: checksum,
        original_filename: "Završni uslovi – v1.pdf",
        uploaded_at: expect.any(String),
      },
    });
    documentRef = response.body.data.document_ref;
    documentId = response.body.data.document_id;
    expect(documentRef).toBe(`offerings/${offeringId}/${documentId}`);

    expect(store.objects.get(documentRef)).toMatchObject({ contentType: "application/pdf", body: pdf });
    const row = await database.storedDocument.findUnique({ where: { id: documentId } });
    expect(row).toMatchObject({
      bucket,
      objectKey: documentRef,
      documentType: "final_terms_sheet",
      offeringId,
      caseId: null,
      contentType: "application/pdf",
      sizeBytes: BigInt(pdf.length),
      sha256Checksum: checksum,
      uploadStatus: "accepted",
      classification: "disclosure",
      originalFilename: "Završni uslovi – v1.pdf",
      deletedAt: null,
    });
    const audit = await database.auditLog.findFirst({
      where: { resourceType: "offering", resourceId: offeringId, action: "offering.disclosure_document_uploaded" },
    });
    expect(audit).toMatchObject({ actorAccountId: staffAccountId });
    expect(audit?.changes).toMatchObject({ document_id: documentId, document_type: "final_terms_sheet", document_ref: documentRef });
  });

  it("lists the upload, newest first, not yet published in any pack, and filters by document_type", async () => {
    const response = await request(app).get(`/internal/v1/offerings/${offeringId}/documents`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [
        {
          document_id: documentId,
          document_type: "final_terms_sheet",
          document_ref: documentRef,
          content_type: "application/pdf",
          size_bytes: pdf.length,
          original_filename: "Završni uslovi – v1.pdf",
          uploaded_at: expect.any(String),
          published_in_pack_id: null,
        },
      ],
    });

    const other = await request(app).get(`/internal/v1/offerings/${offeringId}/documents?document_type=ecsp_kiis`);
    expect(other.status).toBe(200);
    expect(other.body).toEqual({ data: [] });
  });

  it("streams the upload back to staff by document_ref, and 404s any other ref", async () => {
    const response = await request(app)
      .get(`/internal/v1/offerings/${offeringId}/documents`)
      .query({ document_ref: documentRef })
      .buffer(true)
      .parse(rawBody());
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-length"]).toBe(String(pdf.length));
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toEqual(pdf);

    const missing = await request(app)
      .get(`/internal/v1/offerings/${offeringId}/documents`)
      .query({ document_ref: `offerings/${offeringId}/doc_${"0".repeat(32)}` });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "offering.document_not_found", status: 404 });
  });

  it("refuses to publish a pack that quotes a document_ref nobody uploaded to this offering", async () => {
    const response = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/disclosure-packs`)
      .send({
        documents: [
          { document_type: "final_terms_sheet", document_ref: documentRef },
          { document_type: "ecsp_kiis", document_ref: "documents/kiis-pasted-by-hand.pdf" },
        ],
      });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      code: "offering.disclosure_document_unknown",
      status: 422,
      field_errors: [{ field: "documents.1.document_ref", code: "offering.disclosure_document_unknown" }],
    });
    expect(await database.disclosurePack.count({ where: { offeringId } })).toBe(0);
  });

  it("publishes a pack from the upload's document_ref, which the list then reports and the investor download route serves", async () => {
    const published = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/disclosure-packs`)
      .send({ documents: [{ document_type: "final_terms_sheet", document_ref: documentRef }] });
    expect(published.status).toBe(201);
    const packId: string = published.body.data.disclosure_pack_id;
    const packDocumentId: string = published.body.data.documents[0].document_id;
    expect(await database.disclosureDocument.findUnique({ where: { id: packDocumentId } })).toMatchObject({
      disclosurePackId: packId,
      documentType: "final_terms_sheet",
      documentRef,
    });

    const listed = await request(app).get(`/internal/v1/offerings/${offeringId}/documents`);
    expect(listed.body.data[0]).toMatchObject({ document_id: documentId, published_in_pack_id: packId });

    const download = await request(app)
      .get(`/v1/offerings/${offeringId}/documents/${packDocumentId}/download`)
      .buffer(true)
      .parse(rawBody());
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["content-length"]).toBe(String(pdf.length));
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(download.headers["content-disposition"]).toMatch(/^attachment; filename="Zavrsni-uslovi-v1.pdf"$/);
    expect(download.body).toEqual(pdf);
  });

  it("reports the most recent pack once a republish references the same upload again", async () => {
    const republished = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/disclosure-packs`)
      .send({ documents: [{ document_type: "final_terms_sheet", document_ref: documentRef }] });
    expect(republished.status).toBe(201);
    expect(republished.body.data.version).toBe(2);

    const listed = await request(app).get(`/internal/v1/offerings/${offeringId}/documents`);
    expect(listed.body.data[0]).toMatchObject({ document_id: documentId, published_in_pack_id: republished.body.data.disclosure_pack_id });
  });

  it("rejects an unsupported document type, an unsupported MIME type and an unknown offering", async () => {
    const badType = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/documents`)
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "marketing_flyer")
      .send(pdf);
    expect(badType.status).toBe(422);
    expect(badType.body).toMatchObject({ code: "offering.document_type_unsupported", status: 422 });

    const badMime = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/documents`)
      .set("Content-Type", "text/html")
      .set("X-Document-Type", "ecsp_kiis")
      .send(Buffer.from("<html></html>"));
    expect(badMime.status).toBe(422);
    expect(badMime.body).toMatchObject({ code: "offering.document_mime_unsupported", status: 422 });

    const unknownOffering = await request(app)
      .post(`/internal/v1/offerings/offering_missing_${suffix}/documents`)
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "ecsp_kiis")
      .send(pdf);
    expect(unknownOffering.status).toBe(404);
    expect(unknownOffering.body).toMatchObject({ code: "offering.not_found", status: 404 });

    expect(await database.storedDocument.count({ where: { offeringId } })).toBe(1);
    expect(store.objects.size).toBe(1);
  });

  it("keeps nothing from an infected upload or one the scanner could not check", async () => {
    scanResult = "infected";
    const infected = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/documents`)
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "ecsp_kiis")
      .send(pdf);
    expect(infected.status).toBe(422);
    expect(infected.body).toMatchObject({ code: "offering.document_malware_detected", status: 422 });

    scanResult = "down";
    const unscanned = await request(app)
      .post(`/internal/v1/offerings/${offeringId}/documents`)
      .set("Content-Type", "application/pdf")
      .set("X-Document-Type", "ecsp_kiis")
      .send(pdf);
    expect(unscanned.status).toBe(503);
    expect(unscanned.body).toMatchObject({ code: "offering.document_scanner_unavailable", status: 503 });
    scanResult = "clean";

    expect(await database.storedDocument.count({ where: { offeringId } })).toBe(1);
    expect(store.objects.size).toBe(1);
  });
});
