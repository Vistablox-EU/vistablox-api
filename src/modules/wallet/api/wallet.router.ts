import { Router, type RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import type { GetWalletBalanceService } from "../application/get-wallet-balance.service.js";
import type { RegisterWalletService } from "../application/register-wallet.service.js";
import type { RequestWalletTransferService } from "../application/request-wallet-transfer.service.js";
import {
  getWalletBalanceResponseSchema,
  registerWalletBodySchema,
  registerWalletResponseSchema,
  requestWalletTransferBodySchema,
  requestWalletTransferResponseSchema,
} from "./wallet.schemas.js";

export function createWalletRouter(
  requireAuthentication: RequestHandler,
  registerWallet: RegisterWalletService,
  getBalance?: GetWalletBalanceService,
  requestTransfer?: RequestWalletTransferService,
): Router {
  const router = Router();
  router.post("/", requireAuthentication, async (request, response) => {
    const context = requireCustomerContext(response.locals.authContext);
    const body = registerWalletBodySchema.parse(request.body);
    const result = await registerWallet.execute({
      accountId: context.accountId,
      walletAddress: body.wallet_address,
    });
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json(registerWalletResponseSchema.parse(result));
  });
  if (getBalance !== undefined) {
    router.get("/", requireAuthentication, async (request, response) => {
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
