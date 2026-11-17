import { createHash } from "node:crypto";

import { Router } from "express";
import { z } from "zod";

import type {
  ParsedCoinbaseOnrampEvent,
  ReceiveCoinbaseOnrampWebhookService,
} from "../application/coinbase-onramp-webhook.service.js";
import type { CoinbaseOnrampWebhookVerifier } from "../infrastructure/coinbase-onramp-webhook-verifier.js";

// A field that is not the string we expect becomes null instead of failing the
// whole delivery: the receipt stores ids only, and a surprising value in one
// of them must not turn a verified delivery into a failed write that Coinbase
// retries. The length limits match the CHECK constraints on
// money.onramp_webhook_receipts.
const optionalId = z.string().min(1).max(200).nullish().catch(null);

/**
 * The fields read from a verified CDP onramp webhook body. ASSUMED names (see
 * ParsedCoinbaseOnrampEvent): eventType, partnerUserRef, transactionId,
 * txHash. Status, amounts, the wallet address and the user's country are never
 * taken from the body: the worker re-fetches the reservation's transactions
 * from CDP's Transaction Status API, exactly as the minute poll does.
 */
const coinbaseOnrampWebhookBodySchema = z.object({
  eventType: z.string().min(1).max(100),
  partnerUserRef: optionalId,
  transactionId: optionalId,
  txHash: optionalId,
});

// CDP's signature-verification page names X-Event-Id as the delivery's event
// id header. When it is absent, or not a usable id, the digest of the exact
// signed body stands in, so a redelivery of identical bytes is still
// recognised as a duplicate.
const eventIdSchema = z.string().min(1).max(200);

/**
 * Mounted behind express.raw() in app.ts, so request.body is the exact bytes
 * CDP signed. A bad signature is a 401. After that every delivery is
 * acknowledged with 200, including one that is JSON of a shape we do not
 * recognise or an event type we do not act on: Coinbase retries a non-2xx, and
 * a retry cannot fix either. Only ids and the event type ever reach a log line,
 * a receipt or the job payload; the body itself is never stored or logged.
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
    const eventId = eventIdSchema.safeParse(readHeader(request.headers["x-event-id"]));
    await receiveWebhook.execute({
      eventId: eventId.success ? eventId.data : `body-sha256:${createHash("sha256").update(rawBody).digest("hex")}`,
      event: parseEvent(rawBody),
      traceId: String(response.locals.traceId),
    });
    response.json({ received: true });
  });
  return router;
}

function parseEvent(rawBody: Buffer): ParsedCoinbaseOnrampEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  const body = coinbaseOnrampWebhookBodySchema.safeParse(json);
  if (!body.success) return null;
  return {
    eventType: body.data.eventType,
    partnerUserRef: body.data.partnerUserRef ?? null,
    transactionId: body.data.transactionId ?? null,
    txHash: body.data.txHash ?? null,
  };
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
