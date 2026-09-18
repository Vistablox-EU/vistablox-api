import { describe, expect, it } from "vitest";
import { WorkerMetrics } from "../src/shared/health/worker-metrics.js";

describe("WorkerMetrics", () => {
  it("renders stable, scrapeable gauges and counters", () => {
    const metrics = new WorkerMetrics();
    metrics.increment("vistablox_worker_runs_total", 2);
    metrics.set("vistablox_worker_pending_overdue", 3);
    expect(metrics.render()).toBe(
      "vistablox_worker_pending_overdue 3\nvistablox_worker_runs_total 2\n",
    );
  });

  it("does not emit non-finite values", () => {
    const metrics = new WorkerMetrics();
    metrics.set("vistablox_worker_pending_overdue", Number.NaN);
    expect(metrics.render()).toBe("vistablox_worker_pending_overdue 0\n");
  });
});
