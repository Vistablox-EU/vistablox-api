import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseReplayDeadLetterJobArguments } from "../src/cli/replay-dead-letter-job-arguments.js";
import { loadEnvironment } from "../src/config/environment.js";
import { replayJobIdFor } from "../src/shared/jobs/dead-letter-replay.js";
import { JOB_QUEUE_OWNERSHIP, ownershipOf } from "../src/shared/jobs/job-ownership.js";

const base = {
  DATABASE_URL: "postgresql://user:password@localhost:5432/vistablox",
  BETTER_AUTH_SECRET: "a-secure-test-secret-that-is-long-enough",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "user",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "no-reply@example.com",
  DIDIT_API_KEY: "key",
  DIDIT_WORKFLOW_ID: "269214fe-77f7-4b1a-a028-b70e861d73c1",
  DIDIT_CALLBACK_URL: "https://app.vistablox.io/kyc/complete",
  DIDIT_WEBHOOK_SECRET: "a-didit-webhook-secret-value-32-chars",
  DIDIT_APPLICATION_ID: "c2237bc6-a76c-4933-b329-6c81843b45c7",
  DIDIT_ENVIRONMENT: "sandbox",
};

function ensuredQueues(file: string): Array<[string, string]> {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
  return [...source.matchAll(/ensureJobQueue\(\s*\w+,\s*"([^"]+)",\s*"(event|scheduled)"\s*\)/g)].map((match) => [
    match[1] ?? "",
    match[2] ?? "",
  ]);
}

describe("job queue ownership", () => {
  it("covers every queue the API and the worker create, with the same kind", () => {
    const created = [...ensuredQueues("worker.ts"), ...ensuredQueues("server.ts")];
    expect(created.length).toBeGreaterThan(20);
    for (const [name, kind] of created) {
      expect(JOB_QUEUE_OWNERSHIP[name], name).toMatchObject({ kind });
    }
    const createdNames = new Set(created.map(([name]) => name));
    expect(Object.keys(JOB_QUEUE_OWNERSHIP).filter((name) => !createdNames.has(name))).toEqual([]);
  });

  it("puts every settlement queue at tier_1", () => {
    for (const [name, ownership] of Object.entries(JOB_QUEUE_OWNERSHIP)) {
      if (name.startsWith("settlement.")) expect(ownership, name).toMatchObject({ owner: "settlement", tier: "tier_1" });
    }
  });

  it("sends an unknown queue to platform at tier_1, and never matches inherited keys", () => {
    expect(ownershipOf("nope.queue")).toEqual({ kind: "event", owner: "platform", tier: "tier_1", known: false });
    expect(ownershipOf("toString")).toMatchObject({ known: false });
  });
});

describe("DEAD_LETTER_ALERT_WEBHOOK_URL", () => {
  it("is optional, and a blank value from compose disables it", () => {
    expect(loadEnvironment(base).DEAD_LETTER_ALERT_WEBHOOK_URL).toBeUndefined();
    expect(loadEnvironment({ ...base, DEAD_LETTER_ALERT_WEBHOOK_URL: "" }).DEAD_LETTER_ALERT_WEBHOOK_URL).toBeUndefined();
  });

  it("rejects a value that is not a URL", () => {
    expect(() => loadEnvironment({ ...base, DEAD_LETTER_ALERT_WEBHOOK_URL: "not a url" })).toThrow(
      /DEAD_LETTER_ALERT_WEBHOOK_URL/,
    );
  });

  it("accepts http outside production, for a local receiver", () => {
    expect(
      loadEnvironment({ ...base, DEAD_LETTER_ALERT_WEBHOOK_URL: "http://localhost:9000/hook" }).DEAD_LETTER_ALERT_WEBHOOK_URL,
    ).toBe("http://localhost:9000/hook");
  });

  it("requires https in a production build", () => {
    const production = { ...base, NODE_ENV: "production", APP_ENV: "staging" };
    let message = "";
    try {
      loadEnvironment({ ...production, DEAD_LETTER_ALERT_WEBHOOK_URL: "http://hooks.example.com/x" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("DEAD_LETTER_ALERT_WEBHOOK_URL must be an https:// URL");
    let httpsMessage = "";
    try {
      loadEnvironment({ ...production, DEAD_LETTER_ALERT_WEBHOOK_URL: "https://hooks.example.com/x" });
    } catch (error) {
      httpsMessage = error instanceof Error ? error.message : String(error);
    }
    expect(httpsMessage).not.toContain("DEAD_LETTER_ALERT_WEBHOOK_URL");
  });
});

describe("replay-dead-letter arguments", () => {
  const id = "0e9c2f5c-7d0a-4b7e-9d65-4c1b2a3f4e5d";

  it("is a dry run unless --confirm is given", () => {
    expect(parseReplayDeadLetterJobArguments(["--dead-letter-job-id", id])).toEqual({
      ok: true,
      value: { mode: "dry_run", deadLetterJobId: id },
    });
    expect(parseReplayDeadLetterJobArguments(["--dead-letter-job-id", id.toUpperCase(), "--confirm"])).toEqual({
      ok: true,
      value: { mode: "confirm", deadLetterJobId: id },
    });
  });

  it.each([
    [[], "--dead-letter-job-id is required"],
    [["--confirm"], "--dead-letter-job-id is required"],
    [["--dead-letter-job-id", "abc"], "--dead-letter-job-id must be a UUID"],
  ])("refuses %j", (argv, error) => {
    expect(parseReplayDeadLetterJobArguments(argv)).toEqual({ ok: false, error });
  });

  it("refuses unknown options and positionals", () => {
    expect(parseReplayDeadLetterJobArguments(["--dead-letter-job-id", id, "--force"]).ok).toBe(false);
    expect(parseReplayDeadLetterJobArguments([id]).ok).toBe(false);
  });

  it("shows help", () => {
    expect(parseReplayDeadLetterJobArguments(["--help"])).toEqual({ ok: true, value: { mode: "help" } });
  });
});

describe("replay job id", () => {
  it("is a stable UUID per dead-letter entry and differs between entries", () => {
    const a = replayJobIdFor("0e9c2f5c-7d0a-4b7e-9d65-4c1b2a3f4e5d");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(replayJobIdFor("0e9c2f5c-7d0a-4b7e-9d65-4c1b2a3f4e5d")).toBe(a);
    expect(replayJobIdFor("1e9c2f5c-7d0a-4b7e-9d65-4c1b2a3f4e5d")).not.toBe(a);
  });
});
