// Port vistablox-api's routers depend on instead of GetKycStatusService/
// StartKycSessionService/StartProofOfAddressSessionService/
// GetKycAccountForOperationsService directly -- those classes, and the
// KycEligibility data they read/write, now live only in the standalone KYC
// service (src/kyc-server.ts). HttpKycServiceClient (infrastructure/
// kyc-service.client.ts) is the real implementation; every method takes an
// already-authenticated caller's verified accountId, never anything
// request-body-controlled -- that's the actual security boundary once
// vistablox-kyc trusts this gateway's caller instead of re-verifying a
// session itself.
export interface KycServiceGateway {
  getStatus(accountId: string): Promise<{
    data: {
      eligibility_state: string;
      proof_of_address_status: string;
      proof_of_address_current_until: string | null;
      last_verified_at: string | null;
      renewal_due_at: string | null;
      active_session: {
        verification_session_id: string;
        verification_url: string;
        expires_at: string | null;
      } | null;
    };
  }>;
  startSession(input: {
    accountId: string;
    traceId: string;
    residenceCountryCode: string;
    taxResidenceCountryCode: string;
    language?: string;
  }): Promise<{
    data: {
      verification_session_id: string;
      verification_url: string;
      eligibility_state: "not_started";
    };
  }>;
  startProofOfAddressSession(input: {
    accountId: string;
    traceId: string;
    language?: string;
  }): Promise<{
    data: {
      verification_session_id: string;
      verification_url: string;
      proof_of_address_status: "in_progress";
    };
  }>;
  getAccountForOperations(accountId: string): Promise<{
    data: {
      account_id: string;
      eligibility_state: string;
      operational_substatus: string;
      didit_reference: string | null;
      residence_country_code: string | null;
      tax_residence_country_code: string | null;
      proof_of_address_status: string;
      proof_of_address_didit_reference: string | null;
      proof_of_address_provider_status: string | null;
      proof_of_address_provider_updated_at: string | null;
      proof_of_address_current_until: string | null;
      last_verified_at: string | null;
      ever_required_manual_review: boolean;
      renewal_due_at: string | null;
    };
  }>;
  getDisplayProfile(accountId: string): Promise<{
    data: {
      given_name: string;
      family_name: string;
      full_display_name: string;
      synced_at: string;
    } | null;
  }>;
}
