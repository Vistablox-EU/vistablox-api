import { createServer, type Server } from "node:http";
import type { WorkerMetrics } from "./worker-metrics.js";

export const WORKER_HEALTH_PORT = 3_001;

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

/**
 * An internal-only probe for the long-running pg-boss process. Docker calls
 * this on loopback; it is never published as an application endpoint.
 *
 * A live process is not sufficient evidence that the worker can accept work:
 * /health/ready stays unavailable until queue creation, scheduling, and every
 * consumer registration has completed. The recurring heartbeat then makes a
 * stalled event loop visible to Docker's health status.
 */
export class WorkerHeartbeat {
  private server: Server | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private ready = false;
  private lastHeartbeatAt = Date.now();

  public constructor(
    private readonly port = WORKER_HEALTH_PORT,
    private readonly metrics?: WorkerMetrics,
  ) {}

  public async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    this.server = createServer((request, response) => {
      if (request.url === "/health/live") {
        this.respond(response, 200);
        return;
      }

      if (request.url === "/health/ready" && this.isReady()) {
        this.respond(response, 200);
        return;
      }

      if (request.url === "/metrics") {
        const body = this.metrics?.render() ?? "";
        response.writeHead(200, {
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "cache-control": "no-store",
          "content-length": Buffer.byteLength(body),
        });
        response.end(body);
        return;
      }

      this.respond(response, 503);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.port, "127.0.0.1", () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    this.heartbeatTimer = setInterval(() => {
      this.lastHeartbeatAt = Date.now();
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  public markReady(): void {
    this.ready = true;
    this.lastHeartbeatAt = Date.now();
  }

  public async stop(): Promise<void> {
    this.ready = false;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.server === undefined) {
      return;
    }

    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private isReady(): boolean {
    return this.ready && Date.now() - this.lastHeartbeatAt < HEARTBEAT_STALE_AFTER_MS;
  }

  private respond(response: import("node:http").ServerResponse, status: number): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: status === 200 ? "ok" : "unavailable" }));
  }
}
