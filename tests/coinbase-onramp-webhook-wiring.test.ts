import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withoutComments } from "./support/without-comments.js";

// src/worker.ts and src/server.ts are start-up scripts that cannot be imported
// into a test, so what they wire up is checked from their source, the way
// tests/wallet-registry-worker-wiring.test.ts does. Behaviour of what they
// wire is covered by the router, service and integration tests; what nothing
// else covers is that the pieces are connected at all. Without the consumer
// the receipts and jobs of provider_events.coinbase_onramp_webhook pile up and
// the webhook does nothing; without the mount the route answers 404 to
// Coinbase. tsc does not notice either (no noUnusedLocals), and
// tests/job-queues.test.ts only asserts that a consumed queue is also created,
// not that a created event queue is consumed.
//
// Comments are blanked out first: a call that has been commented out must not
// satisfy a check for the call. `flat` is the same code with every run of
// whitespace collapsed to one space, for checks that pin a whole statement.
function load(path: string): { code: string; flat: string } {
  const code = withoutComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));
  return { code, flat: code.replace(/\s+/g, " ") };
}

const worker = load("../src/worker.ts");
const server = load("../src/server.ts");

const queue = "provider_events.coinbase_onramp_webhook";

describe("Coinbase onramp webhook wiring in the worker", () => {
  it("creates the event queue, so a send from the API never hits a missing queue", () => {
    expect(worker.flat).toContain(`await ensureJobQueue(boss, "${queue}", "event");`);
  });

  it("builds the reconciling service only on top of the poller, which needs the CDP client", () => {
    expect(worker.flat).toContain(
      "const pollOnrampTransactions = coinbaseCdpClient === undefined ? undefined : new PollOnrampTransactionsService(offeringRepository, coinbaseCdpClient, logger, undefined, recordOnrampLateEvidence);",
    );
    expect(worker.flat).toContain(
      "const reconcileOnrampWebhook = pollOnrampTransactions === undefined ? undefined : new ReconcileOnrampWebhookService(offeringRepository, pollOnrampTransactions);",
    );
  });

  it("consumes the queue with a literal boss.work, guarded by the service that handles it", () => {
    // Literal, so tests/job-queues.test.ts can see the consumer.
    expect(worker.code).toContain(`boss.work("${queue}"`);
    expect(worker.flat).toContain(`if (reconcileOnrampWebhook !== undefined) { await boss.work("${queue}"`);
  });

  it("hands each job's data to the service, and fails the job when the service throws so pg-boss retries it", () => {
    const start = worker.code.indexOf(`boss.work("${queue}"`);
    expect(start).toBeGreaterThan(-1);
    const end = worker.code.indexOf("\n  });", start);
    expect(end).toBeGreaterThan(start);
    const handler = worker.code.slice(start, end).replace(/\s+/g, " ");

    expect(handler).toContain("for (const job of jobs) {");
    expect(handler).toContain("await reconcileOnrampWebhook.execute(job.data);");
    // The retry rule of ReconcileOnrampWebhookService (a terminal event whose
    // outcome Coinbase's list does not show yet) works by throwing, so a
    // handler that swallowed the error would drop that evidence.
    const caught = handler.indexOf("catch (error) {");
    expect(caught).toBeGreaterThan(-1);
    expect(handler.indexOf("throw error;", caught)).toBeGreaterThan(caught);
  });
});

describe("Coinbase onramp webhook wiring in the API server", () => {
  it("creates the event queue, so the receipt and its job can be written together", () => {
    expect(server.flat).toContain(`await ensureJobQueue(jobQueue, "${queue}", "event");`);
  });

  it("builds the webhook only when both the CDP client and COINBASE_ONRAMP_WEBHOOK_SECRET exist", () => {
    expect(server.flat).toContain(
      "const coinbaseOnrampWebhook = coinbaseCdpClient === undefined || environment.COINBASE_ONRAMP_WEBHOOK_SECRET === undefined ? undefined : {",
    );
  });

  it("verifies with the configured secret and receives into the offering repository", () => {
    expect(server.flat).toContain(
      "verifier: new CoinbaseOnrampWebhookVerifier(environment.COINBASE_ONRAMP_WEBHOOK_SECRET),",
    );
    expect(server.flat).toContain(
      "receiveWebhook: new ReceiveCoinbaseOnrampWebhookService(offeringRepository, logger),",
    );
  });

  it("passes it to createApp when it exists, and passes nothing otherwise, so the route is mounted only then", () => {
    const start = server.code.indexOf("createApp({");
    expect(start).toBeGreaterThan(-1);
    const end = server.code.indexOf("\n});", start);
    expect(end).toBeGreaterThan(start);

    expect(server.code.slice(start, end).replace(/\s+/g, " ")).toContain(
      "...(coinbaseOnrampWebhook === undefined ? {} : { coinbaseOnrampWebhook }),",
    );
  });
});
