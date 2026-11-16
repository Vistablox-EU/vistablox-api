import { Router } from "express";
import { z } from "zod";

import { AppError } from "../../../shared/errors/app-error.js";
import type { ReceiveCoinbaseOnrampWebhookService } from "../application/coinbase-onramp-webhook.service.js";
import type { CoinbaseOnrampWebhookVerifier } from "../infrastructure/coinbase-onramp-webhook-verifier.js";

/**
 * The fields read from a verified CDP onramp webhook body
 * (see docs/coinbase-cdp-onramp.md#webhook). Deliberately lenient and minimal:
 * only eventType and partnerUserRef are read. Status, amounts, the wallet
 * address and the user's country are never taken from the body, because the
 * worker re-fetches the transaction from CDP's Transaction Status API, exactly
 * as the minute poll does.
 */
const coinbaseOnrampWebhookBodySchema = z.object({
  eventType: z.string().min(1).max(100),
  partnerUserRef: z.string().max(200).nullish(),
});

const eventIdSchema = z.string().min(1).max(200);

/**
 * Mounted behind express.raw() in app.ts, so request.body is the exact bytes
 * CDP signed. Only ids and the event type ever reach a log line or the job
 * payload; the body itself is never logged.
 */
export function createCoinbaseOnrampWebhookRouter(
  verifier: CoinbaseOnrampWebhookVerifier,
  receiveWebhook: ReceiveCoinbaseOnrampWebhookService,
): Router {
  const router = Router();
  router.post("/", async (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    verifier.verify({
      rawBody,
      // X-Hook0-Signature is CDP's deprecated name for the same header value.
      signatureHeader:
        readHeader(request.headers["x-webhook-signature"]) ??
        readHeader(request.headers["x-hook0-signature"]),
    });
    const body = coinbaseOnrampWebhookBodySchema.safeParse(parseJson(rawBody));
    if (!body.success) throw invalidPayload();
    const eventId = eventIdSchema.safeParse(readHeader(request.headers["x-event-id"]));
    const result = await receiveWebhook.execute({
      eventType: body.data.eventType,
      partnerUserRef: body.data.partnerUserRef ?? null,
      eventId: eventId.success ? eventId.data : null,
      traceId: String(response.locals.traceId),
    });
    response.json({ received: result.received });
  });
  return router;
}

function parseJson(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw invalidPayload();
  }
}

function invalidPayload(): AppError {
  return new AppError({
    code: "offering.coinbase_webhook_payload_invalid",
    title: "Invalid webhook payload",
    status: 400,
    detail: "The webhook body is not a recognised Coinbase onramp event.",
  });
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
