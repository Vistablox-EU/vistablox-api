import { AppError } from "../../../shared/errors/app-error.js";
import { errorResponseSchema } from "../../../shared/http/error-schema.js";
import type { KycServiceGateway } from "../application/kyc-service-gateway.js";
import { signInternalRequest } from "./internal-api-signature.js";
import {
  displayProfileResponseSchema,
  kycStatusResponseSchema,
  operationsKycAccountResponseSchema,
  startKycSessionResponseSchema,
  startProofOfAddressSessionResponseSchema,
} from "../api/kyc.schemas.js";

type Fetch = typeof globalThis.fetch;

// vistablox-api's implementation of KycServiceGateway: calls vistablox-kyc's
// internal API (kyc-internal.router.ts) over the compose-internal network
// (baseUrl is the Docker Compose service hostname, e.g.
// http://vistablox-kyc:3000 in staging -- never the public domain), signing
// every request the same way DiditWebhookVerifier's own precedent works,
// just for our own internal calls (internal-api-signature.ts). Reconstructs
// AppError from vistablox-kyc's JSON error body rather than collapsing
// everything to a generic failure -- both processes serialize errors
// through the identical shared/http/error-handler.js, so a 409/404/etc.
// from vistablox-kyc reaches this API's own client unchanged.
export class HttpKycServiceClient implements KycServiceGateway {
  public constructor(
    private readonly options: {
      baseUrl: string;
      secret: string;
      fetch?: Fetch;
      timeoutMs?: number;
    },
  ) {}

  public async getStatus(accountId: string): ReturnType<KycServiceGateway["getStatus"]> {
    const response = await this.request(
      "GET",
      `/internal/kyc/status?account_id=${encodeURIComponent(accountId)}`,
    );
    return parseBody(response, kycStatusResponseSchema);
  }

  public async startSession(
    input: Parameters<KycServiceGateway["startSession"]>[0],
  ): ReturnType<KycServiceGateway["startSession"]> {
    const response = await this.request("POST", "/internal/kyc/sessions", {
      account_id: input.accountId,
      trace_id: input.traceId,
      residence_country_code: input.residenceCountryCode,
      tax_residence_country_code: input.taxResidenceCountryCode,
      ...(input.language === undefined ? {} : { language: input.language }),
    });
    return parseBody(response, startKycSessionResponseSchema);
  }

  public async startProofOfAddressSession(
    input: Parameters<KycServiceGateway["startProofOfAddressSession"]>[0],
  ): ReturnType<KycServiceGateway["startProofOfAddressSession"]> {
    const response = await this.request("POST", "/internal/kyc/proof-of-address/sessions", {
      account_id: input.accountId,
      trace_id: input.traceId,
      ...(input.language === undefined ? {} : { language: input.language }),
    });
    return parseBody(response, startProofOfAddressSessionResponseSchema);
  }

  public async getAccountForOperations(
    accountId: string,
  ): ReturnType<KycServiceGateway["getAccountForOperations"]> {
    const response = await this.request(
      "GET",
      `/internal/kyc/accounts/${encodeURIComponent(accountId)}`,
    );
    return parseBody(response, operationsKycAccountResponseSchema);
  }

  public async getDisplayProfile(
    accountId: string,
  ): ReturnType<KycServiceGateway["getDisplayProfile"]> {
    const response = await this.request(
      "GET",
      `/internal/kyc/accounts/${encodeURIComponent(accountId)}/display-profile`,
    );
    return parseBody(response, displayProfileResponseSchema);
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const { signature, timestamp } = signInternalRequest({
      secret: this.options.secret,
      method,
      path,
      body,
    });
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImplementation(new URL(path, this.options.baseUrl), {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-internal-signature": signature,
          "x-internal-timestamp": timestamp,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw kycServiceUnavailableError(error);
    }
    if (!response.ok) {
      throw await toAppError(response);
    }
    return response;
  }
}

async function parseBody<T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> {
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw kycServiceResponseInvalidError(error);
  }
  try {
    return schema.parse(json);
  } catch (error) {
    throw kycServiceResponseInvalidError(error);
  }
}

async function toAppError(response: Response): Promise<AppError> {
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw kycServiceResponseInvalidError(error);
  }
  const parsed = errorResponseSchema.safeParse(json);
  if (!parsed.success) throw kycServiceResponseInvalidError(parsed.error);
  return new AppError({
    code: parsed.data.code,
    title: parsed.data.title,
    status: parsed.data.status,
    detail: parsed.data.detail,
    type: parsed.data.type,
    ...(parsed.data.field_errors === undefined ? {} : { fieldErrors: parsed.data.field_errors }),
  });
}

function kycServiceUnavailableError(cause: unknown): AppError {
  return new AppError({
    code: "identity.kyc_service_unavailable",
    title: "Identity verification unavailable",
    status: 503,
    detail: "The KYC service is temporarily unavailable.",
    cause,
  });
}

function kycServiceResponseInvalidError(cause?: unknown): AppError {
  return new AppError({
    code: "identity.kyc_service_response_invalid",
    title: "Identity verification unavailable",
    status: 502,
    detail: "The KYC service returned an invalid response.",
    cause,
  });
}
