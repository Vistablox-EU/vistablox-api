import { describe, expect, it } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";

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

// name, default, lowest accepted, highest accepted
const alertVariables = [
  ["WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES", 10, 2, 1440],
  ["WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS", 900, 1, 1_000_000],
  ["WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT", 1, 1, 10_000],
  ["WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT", 5, 1, 10_000],
] as const;

describe("wallet registry alert environment", () => {
  it("defaults every threshold when nothing is set", () => {
    expect(loadEnvironment(base)).toMatchObject({
      WALLET_REGISTRY_WATCHER_STALE_AFTER_MINUTES: 10,
      WALLET_REGISTRY_CURSOR_LAG_ALERT_BLOCKS: 900,
      WALLET_REGISTRY_PENDING_OVERDUE_ALERT_COUNT: 1,
      WALLET_REGISTRY_UNMATCHED_EVENTS_ALERT_COUNT: 5,
    });
  });

  it.each(alertVariables)("%s falls back to its default when the variable is blank", (name, fallback) => {
    // A compose file that passes ${NAME:-} hands the worker an empty string.
    expect(loadEnvironment({ ...base, [name]: "" })).toMatchObject({ [name]: fallback });
  });

  it.each(alertVariables)("%s accepts a configured value and its bounds", (name, _fallback, min, max) => {
    expect(loadEnvironment({ ...base, [name]: "7" })).toMatchObject({ [name]: Math.min(Math.max(7, min), max) });
    expect(loadEnvironment({ ...base, [name]: String(min) })).toMatchObject({ [name]: min });
    expect(loadEnvironment({ ...base, [name]: String(max) })).toMatchObject({ [name]: max });
  });

  it.each(alertVariables)("%s rejects a value outside its bounds and anything that is not a whole number", (name, _f, min, max) => {
    for (const bad of [String(min - 1), String(max + 1), "2.5", "abc", "-1"]) {
      expect(() => loadEnvironment({ ...base, [name]: bad })).toThrow();
    }
  });

  it("leaves the existing pending-age threshold as it was", () => {
    expect(loadEnvironment(base).WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES).toBe(5);
    expect(loadEnvironment({ ...base, WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES: "15" })).toMatchObject({
      WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES: 15,
    });
    expect(() => loadEnvironment({ ...base, WALLET_REGISTRY_PENDING_WARN_AFTER_MINUTES: "0" })).toThrow();
  });
});
