import type { Express } from "express";

import type { createRequireAuthentication } from "../modules/auth/api/shared/require-authentication.js";
import type { createRequireFreshAuthentication, createFreshAuthenticationProbe } from "../modules/auth/api/customer/require-fresh-authentication.js";
import type {
  createRequireAdminOperations,
  createRequireAppraisalPartner,
  createRequireLegalPartner,
  createRequireStaffIdentity,
  createRequireStaffWebAuthn,
} from "../modules/auth/api/staff/require-staff-role.js";
import type { createRateLimiter } from "../shared/http/rate-limit.js";
import type { createIdempotencyMiddleware } from "../shared/http/idempotency.js";
import type { AppDependencies, ProtectedApiDependencies } from "./app-dependencies.js";

type RateLimiter = ReturnType<typeof createRateLimiter>;
type IdempotencyMiddleware = ReturnType<typeof createIdempotencyMiddleware>;

/**
 * What every per-module compose function receives: the app to mount on, the
 * dependencies (with protectedApi known to be present), and the middleware
 * built once in composeProtectedApi so each module mounts the same instances.
 */
export interface ProtectedApiContext {
  app: Express;
  dependencies: AppDependencies & { protectedApi: ProtectedApiDependencies };
  requireAuthentication: ReturnType<typeof createRequireAuthentication>;
  requireAdminOperations: ReturnType<typeof createRequireAdminOperations>;
  requireLegalPartner: ReturnType<typeof createRequireLegalPartner>;
  requireAppraisalPartner: ReturnType<typeof createRequireAppraisalPartner>;
  requireStaffIdentity: ReturnType<typeof createRequireStaffIdentity>;
  requireStaffWebAuthn: ReturnType<typeof createRequireStaffWebAuthn>;
  requireFreshAuthentication: ReturnType<typeof createRequireFreshAuthentication> | undefined;
  freshAuthenticationProbe: ReturnType<typeof createFreshAuthenticationProbe> | undefined;
  baselineRateLimiter: RateLimiter | undefined;
  tightenedRateLimiter: RateLimiter | undefined;
  deviceAuthDpopKeyRateLimiter: RateLimiter | undefined;
  reservationCreateIdempotency: IdempotencyMiddleware | undefined;
  reconfirmIdempotency: IdempotencyMiddleware | undefined;
  finalizeIdempotency: IdempotencyMiddleware | undefined;
}
