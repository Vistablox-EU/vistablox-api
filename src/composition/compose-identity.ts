import { createKycOperationsRouter } from "../modules/identity/api/kyc-operations.router.js";
import { createDiditWebhookRouter, createKycRouter } from "../modules/identity/api/kyc.router.js";
import type { ProtectedApiContext } from "./protected-api-context.js";

export function composeIdentity(context: ProtectedApiContext): void {
  const { app, dependencies, requireAuthentication, requireAdminOperations, requireStaffWebAuthn } = context;
  if (dependencies.protectedApi.kyc !== undefined) {
    const kyc = dependencies.protectedApi.kyc;
    app.use(
      "/v1/kyc",
      createKycRouter(
        requireAuthentication,
        kyc.getStatus,
        kyc.startSession,
        kyc.startProofOfAddressSession,
      ),
    );
    app.use(
      "/internal/v1/kyc-accounts",
      createKycOperationsRouter(
        requireAuthentication,
        requireAdminOperations,
        requireStaffWebAuthn,
        kyc.getAccountForOperations,
      ),
    );
    // Reversal (undoing the KYC microservice split): mounted directly
    // here now, unauthenticated like every other Didit-facing surface --
    // this used to live only in src/kyc-app.ts.
    app.use(
      "/webhooks/didit",
      createDiditWebhookRouter(kyc.webhookVerifier, kyc.receiveWebhook),
    );
  }
}
