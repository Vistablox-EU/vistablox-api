import { AppError } from "../../../shared/errors/app-error.js";
import type { ProtectedDisplayProfileProvider } from "./protected-display-profile.js";
import { toPreferencesPayload } from "./update-account-preferences.service.js";
import type { ProfileRepository } from "../repository/profile.repository.js";

export class GetProfileService {
  public constructor(
    private readonly repository: ProfileRepository,
    private readonly displayProfiles: ProtectedDisplayProfileProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string) {
    const profile = await this.repository.get(accountId);
    if (profile === null) {
      throw new AppError({
        code: "investor_profile.not_found",
        title: "Investor profile not found",
        status: 404,
        detail: "The authenticated investor profile does not exist.",
      });
    }
    const displayProfile = await this.displayProfiles.get({
      accountId,
      diditReference: profile.kyc?.diditReference ?? null,
      providerStatus: profile.kyc?.providerStatus ?? null,
    });
    const now = this.clock();
    const proofOfAddressStatus =
      profile.kyc?.proofOfAddressStatus === "current" &&
      profile.kyc.proofOfAddressCurrentUntil !== null &&
      profile.kyc.proofOfAddressCurrentUntil <= now
        ? "expired"
        : profile.kyc?.proofOfAddressStatus ?? "not_started";
    const linkedMethods = new Set(
      profile.loginMethods.map((method) => method.methodType),
    );
    const investmentEligible =
      profile.accountStatus === "active" &&
      profile.kyc?.eligibilityState === "eligible" &&
      profile.kyc.renewalDueAt !== null &&
      profile.kyc.renewalDueAt > now &&
      linkedMethods.has("passkey") &&
      (linkedMethods.has("google") || linkedMethods.has("apple"));
    return {
      data: {
        account_id: profile.accountId,
        account_status: profile.accountStatus,
        contact_email: profile.protectedContactEmail,
        member_since: profile.createdAt.toISOString(),
        display_profile:
          displayProfile === null
            ? null
            : {
                given_name: displayProfile.givenName,
                family_name: displayProfile.familyName,
                full_display_name: displayProfile.fullDisplayName,
                last_synced_at: displayProfile.syncedAt.toISOString(),
              },
        // Every customer account is created by its first-ever linked login
        // method (no password sign-up path exists), and loginMethods is
        // ordered earliest-first (see PrismaProfileRepository.get) -- so
        // index 0 here is exactly the method the registration guard in
        // better-auth-registration-account-guard.plugin.ts protects.
        login_methods: profile.loginMethods.map((method, index) => ({
          method_type: method.methodType,
          linked_at: method.linkedAt.toISOString(),
          is_registration_method: index === 0,
        })),
        kyc: {
          eligibility_state: profile.kyc?.eligibilityState ?? "not_started",
          residence_country_code: profile.kyc?.residenceCountryCode ?? null,
          tax_residence_country_code:
            profile.kyc?.taxResidenceCountryCode ?? null,
          proof_of_address_status: proofOfAddressStatus,
          proof_of_address_current_until:
            profile.kyc?.proofOfAddressCurrentUntil?.toISOString() ?? null,
          last_verified_at: profile.kyc?.lastVerifiedAt?.toISOString() ?? null,
          renewal_due_at: profile.kyc?.renewalDueAt?.toISOString() ?? null,
        },
        investment_summary: {
          reservation_count: profile.activitySummary.reservationCount,
          active_position_count: profile.activitySummary.activePositionCount,
        },
        readiness: {
          investment_eligible: investmentEligible,
          payment_account_ready: profile.walletStatus !== null,
          payout_account_verified:
            profile.walletStatus !== null &&
            profile.walletStatus.registeredAt !== null,
        },
        wallet: {
          status:
            profile.walletStatus === null
              ? "not_registered"
              : profile.walletStatus.registeredAt === null
                ? "pending"
                : "registered",
          requested_at:
            profile.walletStatus?.requestedAt.toISOString() ?? null,
          registered_at:
            profile.walletStatus?.registeredAt?.toISOString() ?? null,
        },
        preferences: toPreferencesPayload(profile.preferences),
        pending_closure_request:
          profile.pendingClosureRequest === null
            ? null
            : {
                reason: profile.pendingClosureRequest.reason,
                requested_at: profile.pendingClosureRequest.requestedAt.toISOString(),
              },
      },
    };
  }
}
