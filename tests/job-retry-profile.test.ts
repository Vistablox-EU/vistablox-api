import { describe, expect, it } from "vitest";

import { JOB_RETRY_OPTIONS, SCHEDULED_JOB_RETRY_OPTIONS } from "../src/shared/jobs/enqueue-job.js";

interface RetryProfile {
  readonly retryLimit: number;
  readonly retryDelay?: number;
  readonly retryBackoff: boolean;
  readonly retryDelayMax?: number;
}

// pg-boss 12.29's failJobsBody (node_modules/pg-boss/dist/plans.js): with
// retryBackoff the wait before retry n (n = 1 for the first retry) is
// LEAST(retry_delay_max, GREATEST(retry_delay, 1) * 2^(n-1) * (1 + random())),
// the exponent capped at 16, in seconds. random() is in [0, 1), so each wait
// lies between the lower bound below and (twice the uncapped base, capped).
function waitBounds(profile: RetryProfile, retryNumber: number): { min: number; max: number } {
  const base = Math.max(profile.retryDelay ?? 0, 1) * 2 ** (Math.min(16, retryNumber) - 1);
  const cap = profile.retryDelayMax ?? Number.POSITIVE_INFINITY;
  return { min: Math.min(cap, base), max: Math.min(cap, 2 * base) };
}

function horizon(profile: RetryProfile): { min: number; max: number; longestWait: number } {
  let min = 0;
  let max = 0;
  let longestWait = 0;
  for (let retry = 1; retry <= profile.retryLimit; retry += 1) {
    const bounds = waitBounds(profile, retry);
    min += bounds.min;
    max += bounds.max;
    longestWait = Math.max(longestWait, bounds.max);
  }
  return { min, max, longestWait };
}

const TWO_HOURS = 2 * 60 * 60;

describe("job retry profiles", () => {
  describe("event jobs (JOB_RETRY_OPTIONS)", () => {
    it("keep retrying for at least two hours even when every jitter draw is the least favourable", () => {
      expect(JOB_RETRY_OPTIONS.retryBackoff).toBe(true);
      expect(horizon(JOB_RETRY_OPTIONS).min).toBeGreaterThanOrEqual(TWO_HOURS);
    });

    it("never wait more than 15 minutes between attempts, so recovery after an outage is prompt", () => {
      expect(horizon(JOB_RETRY_OPTIONS).longestWait).toBeLessThanOrEqual(15 * 60);
    });

    it("pins the documented numbers so a change to them is a deliberate one", () => {
      expect(JOB_RETRY_OPTIONS).toEqual({
        retryLimit: 16,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 900,
      });
      // 30+60+120+240+480 s, then eleven waits of 900 s.
      expect(horizon(JOB_RETRY_OPTIONS).min).toBe(10_830);
      expect(horizon(JOB_RETRY_OPTIONS).max).toBe(11_700);
    });
  });

  describe("scheduled jobs (SCHEDULED_JOB_RETRY_OPTIONS)", () => {
    it("stay on the short baseline: the next cron tick is the real retry, and a long profile would stack a backlog of duplicate runs behind a failing every-minute job", () => {
      expect(SCHEDULED_JOB_RETRY_OPTIONS).toEqual({ retryLimit: 5, retryBackoff: true });
      expect(horizon(SCHEDULED_JOB_RETRY_OPTIONS).max).toBeLessThan(2 * 60);
    });

    it("are distinct from the event profile", () => {
      expect(SCHEDULED_JOB_RETRY_OPTIONS).not.toEqual(JOB_RETRY_OPTIONS);
    });
  });
});
