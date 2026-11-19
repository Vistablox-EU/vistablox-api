import type { Express } from "express";

import { createRequireAuthentication } from "../modules/auth/api/shared/require-authentication.js";
import {
  createFreshAuthenticationProbe,
  createRequireFreshAuthentication,
} from "../modules/auth/api/customer/require-fresh-authentication.js";
import {
  createRequireAdminOperations,
  createRequireAppraisalPartner,
  createRequireLegalPartner,
  createRequireStaffIdentity,
  createRequireStaffWebAuthn,
} from "../modules/auth/api/staff/require-staff-role.js";
import type { AppDependencies, ProtectedApiDependencies } from "./app-dependencies.js";
import { composeAccount } from "./compose-account.js";
import { composeCustomerAuth } from "./compose-customer-auth.js";
import { composeIdentity } from "./compose-identity.js";
import { composeInvestorProfile } from "./compose-investor-profile.js";
import { composeIntake } from "./compose-intake.js";
import { composeOffering } from "./compose-offering.js";
import { composeStaffAuth } from "./compose-staff-auth.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

type Limiters = Pick<
  ProtectedApiContext,
  | "baselineRateLimiter"
  | "tightenedRateLimiter"
  | "deviceAuthDpopKeyRateLimiter"
  | "reservationCreateIdempotency"
  | "reconfirmIdempotency"
  | "finalizeIdempotency"
>;

/**
 * Builds the shared auth middleware once, then mounts each module's routes.
 * The call order is the mount order; prefixes that overlap keep their
 * relative order (offerings, then the investor-profile family).
 */
export function composeProtectedApi(
  app: Express,
  appDependencies: AppDependencies,
  limiters: Limiters,
): void {
  if (appDependencies.protectedApi === undefined) {
    return;
  }
  const dependencies = appDependencies as AppDependencies & {
    protectedApi: ProtectedApiDependencies;
  };
  const { baselineRateLimiter } = limiters;
  const requireAuthentication = createRequireAuthentication(
    dependencies.protectedApi.sessions,
    dependencies.protectedApi.accounts,
    baselineRateLimiter,
    dependencies.protectedApi.dpop,
  );
  const requireAdminOperations = createRequireAdminOperations(
    dependencies.protectedApi.accounts,
  );
  const requireLegalPartner = createRequireLegalPartner(dependencies.protectedApi.accounts);
  const requireAppraisalPartner = createRequireAppraisalPartner(dependencies.protectedApi.accounts);
  const requireStaffIdentity = createRequireStaffIdentity(
    dependencies.protectedApi.accounts,
  );
  const requireStaffWebAuthn = createRequireStaffWebAuthn(
    dependencies.protectedApi.staffWebAuthnRepository,
  );
  const requireFreshAuthentication =
    dependencies.protectedApi.customerSessions === undefined
      ? undefined
      : createRequireFreshAuthentication(
          dependencies.protectedApi.customerSessions.repository,
        );
  // The same rule as requireFreshAuthentication, as a question rather than a
  // gate, for the one route that needs freshness only on some of its paths
  // (replacing a pending wallet claim).
  const freshAuthenticationProbe =
    dependencies.protectedApi.customerSessions === undefined
      ? undefined
      : createFreshAuthenticationProbe(dependencies.protectedApi.customerSessions.repository);

  const context: ProtectedApiContext = {
    app,
    dependencies,
    requireAuthentication,
    requireAdminOperations,
    requireLegalPartner,
    requireAppraisalPartner,
    requireStaffIdentity,
    requireStaffWebAuthn,
    requireFreshAuthentication,
    freshAuthenticationProbe,
    ...limiters,
  };
  composeOffering(context);
  composeInvestorProfile(context);
  composeCustomerAuth(context);
  composeIdentity(context);
  composeStaffAuth(context);
  composeAccount(context);
  composeIntake(context);
}
