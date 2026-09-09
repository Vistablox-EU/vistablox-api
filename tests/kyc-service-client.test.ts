import { describe, expect, it, vi } from "vitest";

import { HttpKycServiceClient } from "../src/modules/identity/infrastructure/kyc-service.client.js";
import { InternalApiSignatureVerifier } from "../src/modules/identity/infrastructure/internal-api-signature.js";

const baseUrl = "http://vistablox-kyc:3000";
const secret = "an-internal-kyc-api-secret-value-32-chars";

describe("KYC service HTTP client", () => {
  it("signs a status request so the real verifier accepts it", async () => {
    let capturedUrl: URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetch = vi.fn().mockImplementation((url: URL, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return Promise.resolve(
        Response.json({
          data: {
            eligibility_state: "eligible",
            proof_of_address_status: "not_started",
            proof_of_address_current_until: null,
            last_verified_at: null,
            renewal_due_at: null,
            active_session: null,
          },
        }),
      );
    });
    const client = new HttpKycServiceClient({ baseUrl, secret, fetch });

    const result = await client.getStatus("acct_01");

    expect(result.data.eligibility_state).toBe("eligible");
    expect(capturedUrl?.toString()).toBe(`${baseUrl}/internal/kyc/status?account_id=acct_01`);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(() =>
      new InternalApiSignatureVerifier(secret).verify({
        method: "GET",
        path: capturedUrl!.pathname + capturedUrl!.search,
        body: undefined,
        signature: headers["x-internal-signature"],
        timestamp: headers["x-internal-timestamp"],
      }),
    ).not.toThrow();
  });

  it("sends startSession's body correctly shaped", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          data: {
            verification_session_id: "269214fe-77f7-4b1a-a028-b70e861d73c1",
            verification_url: "https://verify.didit.me/session/abc",
            eligibility_state: "not_started",
          },
        },
        { status: 201 },
      ),
    );
    const client = new HttpKycServiceClient({ baseUrl, secret, fetch });

    await client.startSession({
      accountId: "acct_01",
      traceId: "trace_1",
      residenceCountryCode: "DE",
      taxResidenceCountryCode: "DE",
      language: "en",
    });

    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`${baseUrl}/internal/kyc/sessions`);
    expect(JSON.parse(String(init.body))).toEqual({
      account_id: "acct_01",
      trace_id: "trace_1",
      residence_country_code: "DE",
      tax_residence_country_code: "DE",
      language: "en",
    });
  });

  it("reconstructs a structured error from a non-2xx response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          type: "https://api.vistablox.io/errors/identity.kyc_session_unavailable",
          code: "identity.kyc_session_unavailable",
          title: "Identity verification session unavailable",
          status: 409,
          detail: "This account cannot start another identity verification session right now.",
          trace_id: "trace_1",
        },
        { status: 409 },
      ),
    );
    const client = new HttpKycServiceClient({ baseUrl, secret, fetch });

    await expect(
      client.startSession({
        accountId: "acct_01",
        traceId: "trace_1",
        residenceCountryCode: "DE",
        taxResidenceCountryCode: "DE",
      }),
    ).rejects.toMatchObject({ code: "identity.kyc_session_unavailable", status: 409 });
  });

  it("reports a network failure as identity.kyc_service_unavailable", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const client = new HttpKycServiceClient({ baseUrl, secret, fetch });

    await expect(client.getStatus("acct_01")).rejects.toMatchObject({
      code: "identity.kyc_service_unavailable",
      status: 503,
    });
  });

  it("reports an unparseable success body as identity.kyc_service_response_invalid", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const client = new HttpKycServiceClient({ baseUrl, secret, fetch });

    await expect(client.getStatus("acct_01")).rejects.toMatchObject({
      code: "identity.kyc_service_response_invalid",
      status: 502,
    });
  });
});
