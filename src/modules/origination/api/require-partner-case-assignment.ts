import type { RequestHandler } from "express";

import type { AccountRepository } from "../../account/repository/account.repository.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { OriginationRepository } from "../repository/origination.repository.js";

// AD-248: legal/appraisal partner work only exists once a case's funding is
// fully collected, and is non-blocking formalization from that point on --
// there is no path back to an earlier stage or into rejection once a case
// gets here. approved_for_final_offering is included because completing
// that final founder step doesn't retroactively cut a partner off from
// finishing (or having finished) their own formalization record.
const PARTNER_ACCESSIBLE_STAGES = new Set(["post_ipo_structuring", "approved_for_final_offering"]);

// AD-166's resource check: role membership (AD-153, require-staff-role.ts)
// answers "can this account act as a legal/appraisal partner at all" -- a
// different question from "is *this* case, at *this* stage, assigned to
// *this* partner's own organization." Run after the role-check middleware,
// never standalone, since it assumes the role already holds.
//
// A case that doesn't exist, isn't assigned to this partner's org, or
// hasn't reached an accessible stage all produce the identical 403 --
// deliberately not distinguished (not even via 404 for "no such case") so
// a partner can't use this endpoint to enumerate cases outside their own
// assignment.
export function createRequirePartnerCaseAssignment(
  role: "legal_partner" | "appraisal_partner",
  accounts: AccountRepository,
  cases: OriginationRepository,
): RequestHandler {
  return async (request, response, next) => {
    try {
      const authContext = response.locals.authContext;
      if (authContext === undefined) throw missingContextError();
      const caseId = request.params.case_id;

      const [assignedOrganizationId, assignment] = await Promise.all([
        accounts.getActivePartnerOrganizationId(authContext.accountId, role),
        typeof caseId === "string" && caseId.length > 0
          ? cases.getCasePartnerAssignment(caseId)
          : Promise.resolve(null),
      ]);

      const caseOrganizationId =
        assignment === null
          ? null
          : role === "legal_partner"
            ? assignment.legalPracticeId
            : assignment.appraisalFirmId;

      const authorized =
        assignment !== null &&
        assignedOrganizationId !== null &&
        caseOrganizationId === assignedOrganizationId &&
        PARTNER_ACCESSIBLE_STAGES.has(assignment.stage);
      if (!authorized) throw partnerCaseForbiddenError();

      next();
    } catch (error) {
      next(error);
    }
  };
}

function missingContextError(): AppError {
  return new AppError({
    code: "authentication.context_missing",
    title: "Authentication unavailable",
    status: 500,
    detail: "The authenticated account context is unavailable.",
  });
}

function partnerCaseForbiddenError(): AppError {
  return new AppError({
    code: "authorization.forbidden",
    title: "Action not permitted",
    status: 403,
    detail:
      "This case is not assigned to your organization, or has not reached a stage open to partner formalization work.",
  });
}
