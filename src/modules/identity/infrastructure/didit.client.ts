import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type { DiditClient } from "../application/didit-client.js";
import {
  diditStatuses,
  type DiditDecisionSummary,
  type DiditStatus,
} from "../domain/kyc-policy.js";

type Fetch = typeof globalThis.fetch;

const createSessionResponseSchema = z.object({
  session_id: z.string().uuid(),
  session_kind: z.enum(["user", "business"]).optional(),
  url: z.url(),
  status: z.string(),
  workflow_id: z.string(),
  vendor_data: z.string(),
});

const warningSchema = z.object({ risk: z.string().nullable().optional() }).passthrough();
const featureSchema = z
  .object({
    status: z.string(),
    warnings: z.array(warningSchema).nullish(),
  })
  .passthrough();
const identitySchema = featureSchema.extend({ date_of_birth: z.string().nullable().optional() });
const amlSchema = featureSchema.extend({ total_hits: z.number().int().min(0).nullable().optional() });
const proofOfAddressSchema = featureSchema.extend({
  issue_date: z.string().nullable().optional(),
  issuing_state: z.string().nullable().optional(),
  poa_parsed_address: z
    .object({ country: z.string().nullable().optional() })
    .passthrough()
    .nullish(),
});
const decisionResponseSchema = z
  .object({
    session_id: z.string().uuid(),
    session_kind: z.enum(["user", "business"]).nullable().optional(),
    workflow_id: z.string().nullable().optional(),
    vendor_data: z.string().nullable().optional(),
    status: z.string(),
    id_verifications: z.array(identitySchema).nullish(),
    liveness_checks: z.array(featureSchema).nullish(),
    face_matches: z.array(featureSchema).nullish(),
    aml_screenings: z.array(amlSchema).nullish(),
    poa_verifications: z.array(proofOfAddressSchema).nullish(),
  })
  .passthrough();

export class HttpDiditClient implements DiditClient {
  public constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      fetch?: Fetch;
      timeoutMs?: number;
    },
  ) {}

  public async createSession(input: {
    workflowId: string;
    accountId: string;
    callbackUrl: string;
    sessionStartId: string;
    purpose: "baseline_kyc" | "owner_proof_of_address";
    language?: string;
  }) {
    const response = await this.request("/v3/session/", {
      method: "POST",
      body: JSON.stringify({
        workflow_id: input.workflowId,
        vendor_data: input.accountId,
        callback: input.callbackUrl,
        metadata: {
          vistablox_session_start_id: input.sessionStartId,
          vistablox_verification_purpose: input.purpose,
        },
        ...(input.language === undefined ? {} : { language: input.language }),
      }),
    });
    const parsed = createSessionResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success) throw invalidProviderResponseError(parsed.error);
    if (parsed.data.session_kind === "business") throw invalidProviderResponseError();
    const status = normalizeDiditStatus(parsed.data.status);
    if (status === null) throw invalidProviderResponseError();
    return {
      sessionId: parsed.data.session_id,
      verificationUrl: parsed.data.url,
      status,
      workflowId: parsed.data.workflow_id,
      vendorData: parsed.data.vendor_data,
    };
  }

  public async getDecision(sessionId: string): Promise<DiditDecisionSummary> {
    const response = await this.request(
      `/v3/session/${encodeURIComponent(sessionId)}/decision/`,
      { method: "GET" },
    );
    const parsed = decisionResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success) throw invalidProviderResponseError(parsed.error);
    return {
      sessionId: parsed.data.session_id,
      sessionKind: parsed.data.session_kind ?? null,
      workflowId: parsed.data.workflow_id ?? null,
      vendorData: parsed.data.vendor_data ?? null,
      status: normalizeDiditStatus(parsed.data.status),
      idVerifications: (parsed.data.id_verifications ?? []).map((feature) => ({
        status: feature.status,
        dateOfBirth: feature.date_of_birth ?? null,
        warnings: toWarnings(feature.warnings),
      })),
      livenessChecks: (parsed.data.liveness_checks ?? []).map(toFeature),
      faceMatches: (parsed.data.face_matches ?? []).map(toFeature),
      amlScreenings: (parsed.data.aml_screenings ?? []).map((feature) => ({
        status: feature.status,
        totalHits: feature.total_hits ?? null,
        warnings: toWarnings(feature.warnings),
      })),
      proofOfAddressVerifications: (parsed.data.poa_verifications ?? []).map(
        (feature) => ({
          status: feature.status,
          issueDate: feature.issue_date ?? null,
          countryCode:
            feature.poa_parsed_address?.country ?? feature.issuing_state ?? null,
          warnings: toWarnings(feature.warnings),
        }),
      ),
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const fetchImplementation = this.options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImplementation(new URL(path, this.options.baseUrl), {
        ...init,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch (error) {
      throw providerUnavailableError(error);
    }
    if (!response.ok) {
      throw providerUnavailableError(
        new Error(`Didit request failed with HTTP ${response.status}`),
      );
    }
    return response;
  }
}

function normalizeDiditStatus(value: string): DiditStatus | null {
  const exact = diditStatuses.find((status) => status === value);
  if (exact !== undefined) return exact;
  const uppercase: Record<string, DiditStatus> = {
    NOT_STARTED: "Not Started",
    IN_PROGRESS: "In Progress",
    IN_REVIEW: "In Review",
    APPROVED: "Approved",
    DECLINED: "Declined",
    RESUBMITTED: "Resubmitted",
    EXPIRED: "Expired",
    ABANDONED: "Abandoned",
    KYC_EXPIRED: "Kyc Expired",
    AWAITING_USER: "Awaiting User",
  };
  return uppercase[value] ?? null;
}

function toFeature(feature: z.infer<typeof featureSchema>) {
  return { status: feature.status, warnings: toWarnings(feature.warnings) };
}

function toWarnings(warnings: z.infer<typeof warningSchema>[] | null | undefined) {
  return (warnings ?? []).map((warning) => ({ risk: warning.risk ?? null }));
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw invalidProviderResponseError(error);
  }
}

function providerUnavailableError(cause: unknown): AppError {
  return new AppError({
    code: "identity.kyc_provider_unavailable",
    title: "Identity verification unavailable",
    status: 503,
    detail: "The identity verification provider is temporarily unavailable.",
    cause,
  });
}

function invalidProviderResponseError(cause?: unknown): AppError {
  return new AppError({
    code: "identity.kyc_provider_response_invalid",
    title: "Identity verification unavailable",
    status: 502,
    detail: "The identity verification provider returned an invalid response.",
    cause,
  });
}
