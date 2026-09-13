import { Router, type RequestHandler } from "express";

import type { GetWalletAccountForOperationsService } from "../application/get-wallet-account-for-operations.service.js";
import {
  operationsWalletAccountResponseSchema,
  walletAccountIdParamsSchema,
} from "./wallet.schemas.js";

// Calls the concrete service directly, in-process, mirroring
// kyc-operations.router.ts exactly: account_id from the path param is fine
// here -- this route is staff-only (WebAuthn-gated), a "trusted,
// already-authorized caller supplies an arbitrary account_id" shape.
export function createWalletOperationsRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  getAccountForOperations: GetWalletAccountForOperationsService,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/:account_id", ...staffOnly, async (request, response) => {
    const params = walletAccountIdParamsSchema.parse(request.params);
    const result = await getAccountForOperations.execute(params.account_id);
    response.setHeader("Cache-Control", "no-store");
    response.json(operationsWalletAccountResponseSchema.parse(result));
  });

  return router;
}
