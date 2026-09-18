import { afterEach, describe, expect, it } from "vitest";

import { WorkerHeartbeat } from "../src/shared/health/worker-heartbeat.js";

const healthPort = 31_000 + (process.pid % 1_000);
let heartbeat: WorkerHeartbeat | undefined;

afterEach(async () => {
  await heartbeat?.stop();
  heartbeat = undefined;
});

describe("WorkerHeartbeat", () => {
  it("reports live while booting, then ready only after worker initialization", async () => {
    heartbeat = new WorkerHeartbeat(healthPort);
    await heartbeat.start();

    const live = await fetch(`http://127.0.0.1:${healthPort}/health/live`);
    expect(live.status).toBe(200);
    await live.arrayBuffer();

    const booting = await fetch(`http://127.0.0.1:${healthPort}/health/ready`);
    expect(booting.status).toBe(503);
    await booting.arrayBuffer();

    heartbeat.markReady();

    const ready = await fetch(`http://127.0.0.1:${healthPort}/health/ready`);
    expect(ready.status).toBe(200);
    await ready.arrayBuffer();
  });

});
