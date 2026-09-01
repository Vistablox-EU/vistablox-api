import { describe, expect, it, vi } from "vitest";

import { HttpDiditClient } from "../src/modules/identity/infrastructure/didit.client.js";

const sessionId = "c2237bc6-a76c-4933-b329-6c81843b45c7";
const workflowId = "269214fe-77f7-4b1a-a028-b70e861d73c1";

describe("Didit HTTP client", () => {
  it("creates a hosted individual session with opaque correlation data", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          session_id: sessionId,
          session_kind: "user",
          url: `https://verify.didit.me/${sessionId}`,
          status: "Not Started",
          workflow_id: workflowId,
          vendor_data: "acct_01",
          session_token: "must-not-be-returned",
        },
        { status: 201 },
      ),
    );
    const client = new HttpDiditClient({
      baseUrl: "https://verification.didit.me",
      apiKey: "secret-api-key",
      fetch,
    });

    const result = await client.createSession({
      workflowId,
      accountId: "acct_01",
      callbackUrl: "https://app.vistablox.eu/kyc/complete",
      sessionStartId: "kyc_start_01",
      purpose: "baseline_kyc",
      language: "en",
    });

    expect(result).toEqual({
      sessionId,
      verificationUrl: `https://verify.didit.me/${sessionId}`,
      status: "Not Started",
      workflowId,
      vendorData: "acct_01",
    });
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://verification.didit.me/v3/session/");
    expect(init.headers).toMatchObject({ "x-api-key": "secret-api-key" });
    expect(JSON.parse(String(init.body))).toEqual({
      workflow_id: workflowId,
      vendor_data: "acct_01",
      callback: "https://app.vistablox.eu/kyc/complete",
      metadata: {
        vistablox_session_start_id: "kyc_start_01",
        vistablox_verification_purpose: "baseline_kyc",
      },
      language: "en",
    });
  });

  it("projects a provider decision to the minimum policy inputs", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        session_id: sessionId,
        session_kind: "user",
        workflow_id: workflowId,
        vendor_data: "acct_01",
        status: "APPROVED",
        id_verifications: [
          {
            status: "Approved",
            date_of_birth: "1990-04-15",
            first_name: "Must not escape adapter",
            document_number: "SECRET",
            warnings: [],
          },
        ],
        liveness_checks: [{ status: "Approved", score: 99 }],
        face_matches: [{ status: "Approved", score: 98 }],
        aml_screenings: [{ status: "Approved", total_hits: 0, matches: [] }],
        poa_verifications: [
          {
            status: "Approved",
            issue_date: "2026-06-15",
            issuing_state: "DEU",
            poa_parsed_address: {
              country: "DE",
              street_1: "Must not escape adapter",
            },
            poa_address: "Private address",
            warnings: [],
          },
        ],
        raw_images: ["private"],
      }),
    );
    const result = await new HttpDiditClient({
      baseUrl: "https://verification.didit.me",
      apiKey: "secret-api-key",
      fetch,
    }).getDecision(sessionId);

    expect(result).toEqual({
      sessionId,
      sessionKind: "user",
      workflowId,
      vendorData: "acct_01",
      status: "Approved",
      idVerifications: [
        { status: "Approved", dateOfBirth: "1990-04-15", warnings: [] },
      ],
      livenessChecks: [{ status: "Approved", warnings: [] }],
      faceMatches: [{ status: "Approved", warnings: [] }],
      amlScreenings: [{ status: "Approved", totalHits: 0, warnings: [] }],
      proofOfAddressVerifications: [
        {
          status: "Approved",
          issueDate: "2026-06-15",
          countryCode: "DE",
          warnings: [],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("raw_images");
    expect(JSON.stringify(result)).not.toContain("Private address");
  });

  it("returns a safe provider error without response content", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response("sensitive upstream error", { status: 401 }),
    );
    const client = new HttpDiditClient({
      baseUrl: "https://verification.didit.me",
      apiKey: "wrong",
      fetch,
    });

    await expect(
      client.createSession({
        workflowId,
        accountId: "acct_01",
        callbackUrl: "https://app.vistablox.eu/kyc/complete",
        sessionStartId: "kyc_start_01",
        purpose: "baseline_kyc",
      }),
    ).rejects.toMatchObject({
      code: "identity.kyc_provider_unavailable",
      message: "The identity verification provider is temporarily unavailable.",
    });
  });
});
