import { Router, type RequestHandler } from "express";

import type { SearchAccountsByEmailService } from "../application/search-accounts.service.js";
import { searchAccountsQuerySchema, searchAccountsResponseSchema } from "./account.schemas.js";

export function createAccountSearchRouter(
  requireAuthentication: RequestHandler,
  requireAdminOperations: RequestHandler,
  requireStaffWebAuthn: RequestHandler,
  searchAccounts: SearchAccountsByEmailService,
): Router {
  const router = Router();
  const staffOnly = [requireAuthentication, requireAdminOperations, requireStaffWebAuthn];

  router.get("/", ...staffOnly, async (request, response) => {
    const query = searchAccountsQuerySchema.parse(request.query);
    const result = await searchAccounts.execute(query.email);
    response.json(searchAccountsResponseSchema.parse(result));
  });

  return router;
}
