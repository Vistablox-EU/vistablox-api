import type { GetKycDisplayProfileService } from "../../modules/identity/application/kyc-display-profile.service.js";
import type {
  ProtectedDisplayProfile,
  ProtectedDisplayProfileProvider,
} from "../../modules/profile/application/protected-display-profile.js";

// Reversal (undoing the KYC microservice split): the Redis cache and the
// live Didit fetch both live in-process again, in identity's own
// GetKycDisplayProfileService, alongside every other Didit call. This class
// keeps only the cheap, local skip check -- most GET /v1/investor-profile
// reads are for accounts with no approved decision yet, and that's already
// known from the same row this caller just read, so there's no reason to
// call through to the service to find out. Once there's something to look
// up, GetKycDisplayProfileService re-derives its own authoritative copy
// rather than trusting the diditReference/providerStatus passed in here.
export class IdentityDisplayProfileProvider implements ProtectedDisplayProfileProvider {
  public constructor(
    private readonly getDisplayProfile: GetKycDisplayProfileService,
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
      const result = await this.getDisplayProfile.execute(input.accountId);
      if (result.data === null) return null;
      return {
        givenName: result.data.given_name,
        familyName: result.data.family_name,
        fullDisplayName: result.data.full_display_name,
        syncedAt: new Date(result.data.synced_at),
      };
    } catch (error) {
      // Same best-effort degradation the old Didit-direct provider used for
      // a Didit outage -- GetKycDisplayProfileService itself already
      // catches Didit/cache failures internally (degrading to a cached or
      // null value), so anything reaching this catch is an unexpected
      // failure one layer further down (e.g. the eligibility read itself).
      this.onError(error, "kyc_display_profile_fetch");
      return null;
    }
  }
}
