import type { DeliverDeadLetterAlert } from "./dead-letter-alert-webhook.js";

type QueueState = { lastAlertAt: number; suppressed: number };

/**
 * Wraps an alert sender so each source queue alerts at most once per window.
 * The first dead letter of a queue alerts at once; later ones inside the
 * window are counted, not sent; the first one after the window is sent with
 * `suppressed` set to the count and the time of the previous alert.
 *
 * Only a delivered alert opens a window (the sender resolves false or throws
 * when the receiver did not take it), so an unreachable webhook is tried again
 * on the next dead letter and the count is kept until one gets through.
 *
 * State is in memory per worker process (phase 1 runs one worker): a restart
 * forgets the windows and alerts again. The consumer logs every dead letter
 * before it gets here, so suppression never removes a log line.
 */
export function throttleDeadLetterAlerts(
  deliver: DeliverDeadLetterAlert,
  options: { windowMs: number; now?: () => number },
): DeliverDeadLetterAlert {
  const now = options.now ?? Date.now;
  const queues = new Map<string, QueueState>();
  return async (alert) => {
    if (options.windowMs <= 0) return deliver(alert);
    const at = now();
    const state = queues.get(alert.job);
    if (state !== undefined && at - state.lastAlertAt < options.windowMs) {
      state.suppressed += 1;
      return true;
    }
    const withCount =
      state !== undefined && state.suppressed > 0
        ? { ...alert, suppressed: { count: state.suppressed, since: new Date(state.lastAlertAt).toISOString() } }
        : alert;
    const delivered = await deliver(withCount);
    if (delivered) queues.set(alert.job, { lastAlertAt: at, suppressed: 0 });
    return delivered;
  };
}
