import { createProfileRouter } from "../modules/profile/api/profile.router.js";
import { GetProfileService } from "../modules/profile/application/get-profile.service.js";
import { UpdateAccountPreferencesService } from "../modules/profile/application/update-account-preferences.service.js";
import { createWalletRouter } from "../modules/wallet/api/wallet.router.js";
import { createWalletOperationsRouter } from "../modules/wallet/api/wallet-operations.router.js";
import { RegisterWalletService } from "../modules/wallet/application/register-wallet.service.js";
import { GetWalletBalanceService } from "../modules/wallet/application/get-wallet-balance.service.js";
import { GetWalletStatusService } from "../modules/wallet/application/get-wallet-status.service.js";
import { GetWalletAccountForOperationsService } from "../modules/wallet/application/get-wallet-account-for-operations.service.js";
import { RequestWalletTransferService } from "../modules/wallet/application/request-wallet-transfer.service.js";
import { createInvestorActivityRouter } from "../modules/investor-activity/api/investor-activity.router.js";
import { ListInvestorCurrentPositionsService, ListInvestorReservationsService } from "../modules/investor-activity/application/list-investor-activity.service.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

// Everything under /v1/investor-profile: profile first, then the wallet
// sub-prefix, then investor activity.
export function composeInvestorProfile(context: ProtectedApiContext): void {
  const { app, dependencies, requireAuthentication, requireAdminOperations, requireStaffWebAuthn, freshAuthenticationProbe } = context;
  if (dependencies.protectedApi.profile !== undefined) {
    const profile = dependencies.protectedApi.profile;
    app.use(
      "/v1/investor-profile",
      createProfileRouter(
        requireAuthentication,
        new GetProfileService(profile.repository, profile.displayProfiles),
        new UpdateAccountPreferencesService(profile.preferencesRepository),
      ),
    );
  }
  if (dependencies.protectedApi.wallet !== undefined) {
    const wallet = dependencies.protectedApi.wallet;
    // Fail at construction, not per request: without the probe every
    // replacement of a pending claim would be refused for ever, with an
    // error no amount of signing in again could clear.
    if (freshAuthenticationProbe === undefined) {
      throw new Error(
        "protectedApi.wallet requires protectedApi.customerSessions: replacing a pending wallet claim needs the fresh-authentication probe",
      );
    }
    app.use(
      "/v1/investor-profile/wallet",
      createWalletRouter(
        requireAuthentication,
        freshAuthenticationProbe,
        new RegisterWalletService(
          wallet.repository,
          wallet.kycEligibilityReader,
          wallet.walletRegistryContractAddress,
        ),
        new GetWalletStatusService(wallet.repository),
        wallet.balances === undefined
          ? undefined
          : new GetWalletBalanceService(
              wallet.repository,
              wallet.balances.pivTokenHoldingsReader,
              wallet.balances.chainReader,
            ),
        wallet.balances === undefined
          ? undefined
          : new RequestWalletTransferService(
              wallet.repository,
              wallet.balances.pivTokenHoldingsReader,
              wallet.balances.chainReader,
            ),
      ),
    );
    app.use(
      "/internal/v1/wallet-accounts",
      createWalletOperationsRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        new GetWalletAccountForOperationsService(wallet.repository),
        wallet.walletRegistrationReconciler,
      ),
    );
  }
  if (dependencies.protectedApi.investorActivity !== undefined) {
    const investorActivity = dependencies.protectedApi.investorActivity;
    app.use(
      "/v1/investor-profile",
      createInvestorActivityRouter(
        requireAuthentication,
        new ListInvestorReservationsService(investorActivity.repository),
        new ListInvestorCurrentPositionsService(investorActivity.repository),
      ),
    );
  }
}
