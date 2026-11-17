// The cron expression the expiry sweep is scheduled with. Pure, so the
// boundaries are pinned by a table test and the worker only wires the result.
//
// Only a divisor of 60 gives an even spacing within every hour; the
// environment schema refuses the rest, and this refuses them again so a caller
// that skipped the schema cannot schedule an uneven sweep.

/** The minute intervals that divide an hour evenly. */
export const WALLET_CLAIM_EXPIRY_SWEEP_INTERVALS_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] as const;

export function walletClaimExpiryCron(intervalMinutes: number): string {
  if (!(WALLET_CLAIM_EXPIRY_SWEEP_INTERVALS_MINUTES as readonly number[]).includes(intervalMinutes)) {
    throw new RangeError(
      `Wallet claim expiry sweep interval must divide 60 minutes (${WALLET_CLAIM_EXPIRY_SWEEP_INTERVALS_MINUTES.join(", ")}), got ${intervalMinutes}.`,
    );
  }
  if (intervalMinutes === 1) return "* * * * *";
  if (intervalMinutes === 60) return "0 * * * *";
  return `*/${intervalMinutes} * * * *`;
}
