import { describe, expect, it, vi } from "vitest";

import { loadEnvironment } from "../src/config/environment.js";
import {
  ExpirePendingWalletRegistrationsService,
  WALLET_REGISTRATION_EXPIRY_SKIPPED,
} from "../src/modules/wallet/application/expire-pending-wallet-registrations.service.js";
import {
  WALLET_CLAIM_EXPIRY_SWEEP_INTERVALS_MINUTES,
  walletClaimExpiryCron,
} from "../src/modules/wallet/domain/wallet-claim-expiry-schedule.js";
import type { WalletRegistryWatcherAssessment } from "../src/modules/wallet/repository/wallet.repository.js";

// Pending wallet claims expire after a configurable TTL (#177; AD-287, decided
// 2026-11-17). The query and its audit rows are covered in
// tests/wallet-claim-expiry.integration.test.ts, the watcher gate in
// tests/wallet-registry-expiry-gate.test.ts.
const now = new Date("2026-11-16T12:00:00.000Z");
const open: WalletRegistryWatcherAssessment = { mayExpire: true, reasons: [] };

function makeSweep(options: {
  assessment?: WalletRegistryWatcherAssessment | Error;
  expireAfterHours?: number;
  batchSize?: number;
  expired?: { checked: number; expired: number };
}) {
  const expirePendingWalletRegistrations = vi.fn().mockResolvedValue(options.expired ?? { checked: 0, expired: 0 });
  const assess = vi.fn(async () => {
    const assessment = options.assessment ?? open;
    if (assessment instanceof Error) throw assessment;
    return assessment;
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new ExpirePendingWalletRegistrationsService(
    { expirePendingWalletRegistrations },
    { assess },
    logger,
    () => now,
    {
      ...(options.expireAfterHours === undefined ? {} : { expireAfterHours: options.expireAfterHours }),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    },
  );
  return { service, expirePendingWalletRegistrations, assess, logger };
}

describe("ExpirePendingWalletRegistrationsService", () => {
  it("expires claims requested at or before now minus the configured hours, at most the configured batch, and reports what it did", async () => {
    const { service, expirePendingWalletRegistrations, assess } = makeSweep({
      expireAfterHours: 6,
      batchSize: 40,
      expired: { checked: 3, expired: 2 },
    });

    await expect(service.execute("trace")).resolves.toEqual({ checked: 3, acted: 2 });
    expect(assess).toHaveBeenCalledWith(now);
    expect(expirePendingWalletRegistrations).toHaveBeenCalledWith({
      cutoff: new Date("2026-11-16T06:00:00.000Z"),
      now,
      batchSize: 40,
    });
  });

  it("defaults to a 24-hour lifetime and a batch of 500", async () => {
    const { service, expirePendingWalletRegistrations } = makeSweep({});

    await service.execute("trace");

    expect(expirePendingWalletRegistrations).toHaveBeenCalledWith({
      cutoff: new Date("2026-11-15T12:00:00.000Z"),
      now,
      batchSize: 500,
    });
  });

  it("says nothing when it runs: a completed run is the worker's own log line", async () => {
    const { service, logger } = makeSweep({ expired: { checked: 1, expired: 1 } });

    await service.execute("trace");

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // The sweep skips while the registry watcher is stale or lagging, and when
  // the watcher's health cannot be read (fail closed toward not expiring).
  describe("while the watcher is not trusted", () => {
    it.each([
      { name: "stalled", reasons: ["wallet_registry.watcher_stalled"] },
      { name: "lagging", reasons: ["wallet_registry.cursor_lag"] },
      { name: "ahead of the chain", reasons: ["wallet_registry.cursor_ahead_of_chain"] },
      { name: "stalled and lagging", reasons: ["wallet_registry.watcher_stalled", "wallet_registry.cursor_lag"] },
    ])("expires nothing when the watcher is $name, and says so once, at info", async ({ reasons }) => {
      const { service, expirePendingWalletRegistrations, logger } = makeSweep({ assessment: { mayExpire: false, reasons } });

      await expect(service.execute("trace_1")).resolves.toEqual({ checked: 0, acted: 0 });

      expect(expirePendingWalletRegistrations).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        {
          event: WALLET_REGISTRATION_EXPIRY_SKIPPED,
          job: "maintenance.wallet_registration_expiry",
          trace_id: "trace_1",
          reasons,
        },
        expect.stringContaining("skipped"),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("expires nothing when the health snapshot cannot be read, and says so once, at warn, without the error's URL", async () => {
      const { service, expirePendingWalletRegistrations, logger } = makeSweep({
        assessment: new Error("connect ECONNREFUSED https://db.internal.example/path?token=abc"),
      });

      await expect(service.execute("trace_2")).resolves.toEqual({ checked: 0, acted: 0 });

      expect(expirePendingWalletRegistrations).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields, message] = logger.warn.mock.calls[0]!;
      expect(fields).toMatchObject({
        event: WALLET_REGISTRATION_EXPIRY_SKIPPED,
        job: "maintenance.wallet_registration_expiry",
        trace_id: "trace_2",
        reasons: ["health_unreadable"],
      });
      expect(message).toContain("could not be read");
      expect(JSON.stringify({ message: fields.err.message })).not.toContain("db.internal.example");
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("asks again on the next run: a skip is not remembered", async () => {
      const { service, expirePendingWalletRegistrations, assess } = makeSweep({});
      assess.mockResolvedValueOnce({ mayExpire: false, reasons: ["wallet_registry.watcher_stalled"] });

      await service.execute("first");
      await service.execute("second");

      expect(assess).toHaveBeenCalledTimes(2);
      expect(expirePendingWalletRegistrations).toHaveBeenCalledTimes(1);
    });

    it("does not swallow a failure of the expiry itself: the run fails and is retried", async () => {
      const { service, expirePendingWalletRegistrations } = makeSweep({});
      expirePendingWalletRegistrations.mockRejectedValue(new Error("database down"));

      await expect(service.execute("trace")).rejects.toThrow("database down");
    });
  });
});

describe("walletClaimExpiryCron", () => {
  it.each([
    [1, "* * * * *"],
    [2, "*/2 * * * *"],
    [5, "*/5 * * * *"],
    [15, "*/15 * * * *"],
    [30, "*/30 * * * *"],
    [60, "0 * * * *"],
  ])("schedules a %i-minute sweep as %s", (minutes, cron) => {
    expect(walletClaimExpiryCron(minutes)).toBe(cron);
  });

  it("accepts exactly the divisors of 60", () => {
    for (let minutes = -1; minutes <= 61; minutes += 1) {
      const divides = minutes >= 1 && minutes <= 60 && 60 % minutes === 0;
      if (divides) {
        expect(WALLET_CLAIM_EXPIRY_SWEEP_INTERVALS_MINUTES).toContain(minutes);
        expect(() => walletClaimExpiryCron(minutes)).not.toThrow();
      } else {
        expect(() => walletClaimExpiryCron(minutes), String(minutes)).toThrow(RangeError);
      }
    }
    expect(() => walletClaimExpiryCron(7.5)).toThrow(RangeError);
    expect(() => walletClaimExpiryCron(Number.NaN)).toThrow(RangeError);
  });
});

describe("WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS", () => {
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
  const name = "WALLET_REGISTRY_PENDING_EXPIRE_AFTER_HOURS";

  it("defaults to 24 hours, also when the compose file passes it blank", () => {
    expect(loadEnvironment(base)[name]).toBe(24);
    expect(loadEnvironment({ ...base, [name]: "" })[name]).toBe(24);
  });

  it("accepts 1 to 720 hours and refuses anything else", () => {
    expect(loadEnvironment({ ...base, [name]: "1" })[name]).toBe(1);
    expect(loadEnvironment({ ...base, [name]: "720" })[name]).toBe(720);
    for (const bad of ["0", "721", "2.5", "abc", "-1"]) {
      expect(() => loadEnvironment({ ...base, [name]: bad })).toThrow();
    }
  });
});

describe("the expiry sweep's interval and batch", () => {
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
  const sweep = "WALLET_REGISTRY_PENDING_EXPIRE_SWEEP_MINUTES";
  const batch = "WALLET_REGISTRY_PENDING_EXPIRE_BATCH_SIZE";

  it("defaults to every 15 minutes and 500 claims, also when the compose file passes them blank", () => {
    expect(loadEnvironment(base)).toMatchObject({ [sweep]: 15, [batch]: 500 });
    expect(loadEnvironment({ ...base, [sweep]: "", [batch]: "" })).toMatchObject({ [sweep]: 15, [batch]: 500 });
  });

  it("accepts exactly the divisors of 60 as the sweep interval", () => {
    for (const minutes of WALLET_CLAIM_EXPIRY_SWEEP_INTERVALS_MINUTES) {
      expect(loadEnvironment({ ...base, [sweep]: String(minutes) })[sweep]).toBe(minutes);
    }
    for (const bad of ["0", "7", "8", "9", "11", "13", "45", "61", "120", "1.5", "abc", "-15"]) {
      expect(() => loadEnvironment({ ...base, [sweep]: bad }), bad).toThrow(sweep);
    }
  });

  it("accepts 1 to 5000 claims per sweep and refuses anything else", () => {
    expect(loadEnvironment({ ...base, [batch]: "1" })[batch]).toBe(1);
    expect(loadEnvironment({ ...base, [batch]: "5000" })[batch]).toBe(5000);
    for (const bad of ["0", "5001", "2.5", "abc", "-1"]) {
      expect(() => loadEnvironment({ ...base, [batch]: bad }), bad).toThrow(batch);
    }
  });
});
