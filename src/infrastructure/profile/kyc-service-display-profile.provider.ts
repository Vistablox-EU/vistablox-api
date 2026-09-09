import type { KycServiceGateway } from "../../modules/identity/application/kyc-service-gateway.js";
import type {
  ProtectedDisplayProfile,
  ProtectedDisplayProfileProvider,
} from "../../modules/investor-profile/application/protected-display-profile.js";

// Replaces DiditProtectedDisplayProfileProvider (Phase 6): the Redis cache
// and the live Didit fetch both moved into the KYC service's own
// GetKycDisplayProfileService, alongside every other Didit call. This class
// keeps only the cheap, local skip check -- most GET /v1/investor-profile
// reads are for accounts with no approved decision yet, and that's already
// known from the same row this caller just read, so there's no reason to
// pay an internal HTTP round trip to find out. Once there's something to
// look up, the KYC service re-derives its own authoritative copy rather
// than trusting the diditReference/providerStatus passed in here.
export class KycServiceDisplayProfileProvider implements ProtectedDisplayProfileProvider {
  public constructor(
    private readonly kycService: KycServiceGateway,
    private readonly onError: (error: unknown, operation: string) => void = () => {},
  ) {}

  public async get(input: {
    accountId: string;
    diditReference: string | null;
    providerStatus: string | null;
  }): Promise<ProtectedDisplayProfile | null> {
    if (input.diditReference === null || input.providerStatus !== "Approved") {
      return null;
    }
    try {
      const result = await this.kycService.getDisplayProfile(input.accountId);
      if (result.data === null) return null;
      return {
        givenName: result.data.given_name,
        familyName: result.data.family_name,
        fullDisplayName: result.data.full_display_name,
        syncedAt: new Date(result.data.synced_at),
      };
    } catch (error) {
      // Same best-effort degradation the old Didit-direct provider used for
      // a Didit outage -- just one layer up now, since a KYC-service outage
      // is the new failure mode this internal hop introduces. There is no
      // local cache left to fall back to here (see the class comment above),
      // so this degrades straight to null rather than a stale value.
      this.onError(error, "kyc_service_display_profile_fetch");
      return null;
    }
  }
}
