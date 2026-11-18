import { createAccountSearchRouter } from "../modules/account/api/account.router.js";
import { SearchAccountsByEmailService } from "../modules/account/application/search-accounts.service.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

export function composeAccount(context: ProtectedApiContext): void {
  const { app, dependencies, requireAuthentication, requireAdminOperations, requireStaffWebAuthn } = context;
  app.use(
    "/internal/v1/accounts",
    createAccountSearchRouter(
      requireAuthentication,
      requireAdminOperations,
      requireStaffWebAuthn,
      new SearchAccountsByEmailService(dependencies.protectedApi.accounts),
    ),
  );
}
