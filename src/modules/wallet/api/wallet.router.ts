import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { GetWalletBalanceService } from "../application/get-wallet-balance.service.js";
import type { GetWalletStatusService } from "../application/get-wallet-status.service.js";
import type { RegisterWalletService } from "../application/register-wallet.service.js";
import type { RequestWalletTransferService } from "../application/request-wallet-transfer.service.js";
import {
  getWalletBalanceResponseSchema,
  getWalletStatusResponseSchema,
  registerWalletBodySchema,
  registerWalletResponseSchema,
  requestWalletTransferBodySchema,
  requestWalletTransferResponseSchema,
} from "./wallet.schemas.js";

// Whether the caller's session confirmed who is holding the device recently
// enough. Defined here so the wallet module imports nothing from auth: app.ts
// injects the auth module's probe, and this router only passes the answer on
// as a boolean. It is asked with the server-set auth context and never with a
// request field.
export type WalletFreshAuthenticationProbe = (
  context: Express.Locals["authContext"],
) => Promise<boolean>;

export function createWalletRouter(
  requireAuthentication: RequestHandler,
  isFreshlyAuthenticated: WalletFreshAuthenticationProbe,
  registerWallet: RegisterWalletService,
  getStatus: GetWalletStatusService,
  getBalance?: GetWalletBalanceService,
  requestTransfer?: RequestWalletTransferService,
): Router {
  const router = Router();
  router.post("/", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const body = registerWalletBodySchema.parse(request.body);
    // Freshness only matters when this request would replace the account's own
    // pending claim, which is decided later under the row lock; this route
    // never refuses on it. Asked after validation so a bad body costs no
    // lookup. `=== true` so a loose probe answer (undefined, "true") is not
    // fresh. A probe that rejects becomes a 500 with nothing written.
    const freshAuthentication = (await isFreshlyAuthenticated(response.locals.authContext)) === true;
    const result = await registerWallet.execute({
      accountId: context.accountId,
      walletAddress: body.wallet_address,
      freshAuthentication,
    });
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(registerWalletResponseSchema.parse(result));
  });
  // Address + registration status only -- a plain DB read, no chain access,
  // so this stays available regardless of whether CHAIN_* is configured.
  // Callers that need on-chain capital/token balances use GET /balance
  // instead, which is genuinely chain-dependent and stays gated on it.
  router.get("/", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const result = await getStatus.execute(context.accountId);
    response.setHeader("Cache-Control", "no-store");
    response.json(getWalletStatusResponseSchema.parse(result));
  });
  if (getBalance !== undefined) {
    router.get("/balance", requireAuthentication, async (request, response) => {
      const context = requireCustomerContext(response.locals.authContext);
      const result = await getBalance.execute(context.accountId);
      response.setHeader("Cache-Control", "no-store");
      response.json(getWalletBalanceResponseSchema.parse(result));
    });
  }
  if (requestTransfer !== undefined) {
    router.post("/transfers", requireAuthentication, async (request, response) => {
      const context = requireCustomerContext(response.locals.authContext);
      const body = requestWalletTransferBodySchema.parse(request.body);
      const result = await requestTransfer.execute({
        accountId: context.accountId,
        pivId: body.piv_id,
        toWalletAddress: body.to_wallet_address,
        amount: body.amount,
      });
      response.setHeader("Cache-Control", "no-store");
      response.json(requestWalletTransferResponseSchema.parse(result));
    });
  }
  return router;
}

function requireCustomerContext(
  context: Express.Locals["authContext"],
): { accountId: string } {
  if (context === undefined) {
    throw new AppError({
      code: "authentication.context_missing",
      title: "Authentication unavailable",
      status: 500,
      detail: "The authenticated account context is unavailable.",
    });
  }
  if (context.population !== "customer") {
    throw new AppError({
      code: "authorization.forbidden",
      title: "Action not permitted",
      status: 403,
      detail: "Investor profiles are available only to customer accounts.",
    });
  }
  return { accountId: context.accountId };
}
