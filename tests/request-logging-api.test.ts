import { Writable } from "node:stream";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createLogger } from "../src/infrastructure/logging/logger.js";
import type { AccountRepository } from "../src/modules/account/repository/account.repository.js";
import type { SessionResolver } from "../src/modules/auth/application/shared/session-resolver.js";
import type { UploadCaseDocumentService } from "../src/modules/intake/application/upload-case-document.service.js";
import type { IntakeRepository } from "../src/modules/intake/repository/intake.repository.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";

// What the request log line for a request looks like once the real
// pino-http middleware, the real logger configuration and the real routes are
// in play. These tests read the bytes the logger wrote to its destination, so
// they cover what a log store would receive, not an intermediate object.

const customerEmail = "jane.doe@customer-example.test";
const encodedCustomerEmail = "jane.doe%40customer-example.test";
const uploadFilename = "Jane Doe - Passport.pdf";

function fakeEmailSender(): EmailSender {
  return {
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn(),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    sendAccountRecoveryCaseOpenedEmail: vi.fn(),
    sendAccountRecoveryApprovedEmail: vi.fn(),
    sendAccountRecoveryRejectedEmail: vi.fn(),
    sendAccountRecoveryCompletedEmail: vi.fn(),
    sendPasskeyRecoveryEmail: vi.fn(),
    sendDeviceReplacementCodeEmail: vi.fn(),
  };
}

function buildApp() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const sessions: SessionResolver = {
    resolve: vi.fn().mockResolvedValue({
      betterAuthUserId: "auth_actor",
      providerSessionId: "session_actor",
      population: "staff_partner",
    }),
  };
  const accounts: AccountRepository = {
    findByBetterAuthUserId: vi.fn().mockResolvedValue({ accountId: "acct_founder", status: "active" }),
    findByEmail: vi.fn().mockResolvedValue([
      { accountId: "acct_owner", email: customerEmail, status: "active" },
    ]),
    hasActiveStaffRole: vi.fn().mockResolvedValue(true),
    hasAnyActiveStaffRole: vi.fn().mockResolvedValue(true),
    provision: vi.fn(),
    syncVerifiedContactEmail: vi.fn(),
    getActivePartnerOrganizationId: vi.fn().mockResolvedValue(null),
  };
  const documentUpload = {
    execute: vi.fn().mockResolvedValue({ document_id: "doc_01" }),
  } as unknown as UploadCaseDocumentService;

  const app = createApp({
    databaseProbe: { check: vi.fn() },
    offeringRepository: {
      listPublic: vi.fn().mockResolvedValue([]),
      getInvestorDetail: vi.fn().mockResolvedValue(null),
    },
    logger: createLogger("info", destination),
    corsOrigins: [],
    protectedApi: {
      accounts,
      sessions,
      intakeRepository: {} as unknown as IntakeRepository,
      documentUpload,
      emailSender: fakeEmailSender(),
      staffWebAuthnRepository: {
        listCredentials: vi.fn().mockResolvedValue([]),
        findCredential: vi.fn().mockResolvedValue(null),
        isSessionVerified: vi.fn().mockResolvedValue(true),
        replaceChallenge: vi.fn(),
        getActiveChallenge: vi.fn().mockResolvedValue(null),
        failChallenge: vi.fn().mockResolvedValue(false),
        completeRegistration: vi.fn().mockResolvedValue(false),
        completeAuthentication: vi.fn().mockResolvedValue(false),
      },
      staffWebAuthnCeremony: {
        generateRegistrationOptions: vi.fn(),
        verifyRegistration: vi.fn(),
        generateAuthenticationOptions: vi.fn(),
        verifyAuthentication: vi.fn(),
      },
    },
  });
  return { app, lines, documentUpload };
}

// The request-completed line is written when the response closes, which can
// be a tick after supertest has the body, so wait for it rather than assume.
async function completedEntry(lines: string[]): Promise<Record<string, any>> {
  await vi.waitFor(() => {
    expect(lines.some((line) => line.includes('"res"'))).toBe(true);
  });
  const line = lines.find((candidate) => candidate.includes('"res"'));
  return JSON.parse(line ?? "{}");
}

describe("request log line, end to end", () => {
  it("does not write the searched customer email from the query string, in any form", async () => {
    const { app, lines } = buildApp();

    const response = await request(app)
      .get(`/internal/v1/accounts?email=${encodedCustomerEmail}`)
      .set("x-trace-id", "req_search_01");
    expect(response.status).toBe(200);
    expect(response.body.data[0].email).toBe(customerEmail);

    const entry = await completedEntry(lines);
    const output = lines.join("");
    expect(output).not.toContain(customerEmail);
    expect(output).not.toContain(encodedCustomerEmail);
    expect(output).not.toContain("jane.doe");
    expect(output).not.toContain("customer-example");
    expect(entry.req.url).toBe("/internal/v1/accounts?email=[REDACTED]");
    expect(entry.req.query).toEqual({ email: "[REDACTED]" });
    expect(entry.req.id).toBe("req_search_01");
    expect(entry.req.method).toBe("GET");
    expect(entry.res.statusCode).toBe(200);
  });

  it("masks an email-shaped value under any parameter name, and keeps the benign parameters readable", async () => {
    const { app, lines } = buildApp();

    await request(app).get(`/internal/v1/accounts?q=${encodedCustomerEmail}&limit=5&after=cursor_01`);

    const entry = await completedEntry(lines);
    expect(lines.join("")).not.toContain("jane.doe");
    expect(entry.req.url).toBe("/internal/v1/accounts?q=[REDACTED]&limit=5&after=cursor_01");
    expect(entry.req.query).toEqual({ q: "[REDACTED]", limit: "5", after: "cursor_01" });
  });

  it("masks credentials carried in the query string", async () => {
    const { app, lines } = buildApp();

    await request(app).get("/v1/offerings?token=verification-token-value&limit=1");

    const entry = await completedEntry(lines);
    expect(lines.join("")).not.toContain("verification-token-value");
    expect(entry.req.url).toBe("/v1/offerings?token=[REDACTED]&limit=1");
  });

  it("does not write the filename of an upload, and the upload itself is unaffected", async () => {
    const { app, lines, documentUpload } = buildApp();

    const response = await request(app)
      .post("/internal/v1/intake-cases/case_01/documents")
      .set("content-type", "application/pdf")
      .set("x-document-type", "ownership_declaration")
      .set("x-original-filename", uploadFilename)
      .send(Buffer.from("%PDF-1.4"));
    expect(response.status).toBe(201);
    expect(documentUpload.execute).toHaveBeenCalledWith(
      expect.objectContaining({ originalFilename: uploadFilename }),
    );

    const entry = await completedEntry(lines);
    const output = lines.join("");
    expect(output).not.toContain("Jane Doe");
    expect(output).not.toContain("Passport");
    expect(entry.req.headers["x-original-filename"]).toBe("[REDACTED]");
    expect(entry.req.headers["x-document-type"]).toBe("ownership_declaration");
  });

  it("does not write the DPoP proof header, alongside the credentials it already censored", async () => {
    const { app, lines } = buildApp();

    await request(app)
      .get("/v1/offerings")
      .set("authorization", "DPoP access-token-value")
      .set("dpop", "eyJ0eXAiOiJkcG9wK2p3dCJ9.proof-body.proof-signature");

    const entry = await completedEntry(lines);
    const output = lines.join("");
    expect(output).not.toContain("proof-body");
    expect(output).not.toContain("access-token-value");
    expect(entry.req.headers.dpop).toBe("[REDACTED]");
    expect(entry.req.headers.authorization).toBe("[REDACTED]");
  });

  it("changes nothing else about the line: same keys, and the client address and trace id are kept", async () => {
    const { app, lines } = buildApp();

    await request(app)
      .get("/v1/offerings?limit=1")
      .set("user-agent", "vistablox-test/1.0")
      .set("x-forwarded-for", "203.0.113.7");

    const entry = await completedEntry(lines);
    expect(Object.keys(entry).sort()).toEqual(
      ["level", "msg", "req", "res", "responseTime", "time"].sort(),
    );
    expect(Object.keys(entry.req).sort()).toEqual(
      ["headers", "id", "method", "params", "query", "remoteAddress", "remotePort", "url"].sort(),
    );
    expect(Object.keys(entry.res).sort()).toEqual(["headers", "statusCode"]);
    expect(entry.req.url).toBe("/v1/offerings?limit=1");
    expect(entry.req.query).toEqual({ limit: "1" });
    expect(entry.req.remoteAddress).toBeTypeOf("string");
    expect(entry.req.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(entry.req.headers["user-agent"]).toBe("vistablox-test/1.0");
    expect(entry.req.id).toMatch(/^req_/);
  });
});
