/**
 * Pure calculation rules for AD-042's "distributable net rental proceeds"
 * pro-rata claim. Deliberately built ahead of AD-232/AD-206's named trigger
 * (a real property nearing finalization) at the founder's explicit
 * direction — see the schema's own comments for the governance checkpoint
 * (operating_distributions.approved_at) that keeps this from paying out
 * unilaterally once real numbers exist.
 *
 * Money and unit-count inputs/outputs are decimal strings, matching the
 * existing offering/domain/currency.ts convention of never doing money math
 * in floating point. This module doesn't import that one: cents-only
 * precision is too coarse for a per-unit amount (a small property's
 * distributable net divided across many units can be a fraction of a
 * cent per unit — see computeAmountPerUnit), so distribution math needs
 * six-decimal ("micro") precision throughout, not two.
 */

const MICROS_PER_UNIT = 1_000_000n;

/** Parses a decimal string (up to 6 fractional digits) into millionths. */
function toMicros(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > 6) {
    throw new Error(`toMicros: "${value}" has more than 6 fractional digits`);
  }
  const paddedFraction = fraction.padEnd(6, "0");
  const micros = BigInt(whole) * MICROS_PER_UNIT + BigInt(paddedFraction);
  return negative ? -micros : micros;
}

/** Formats millionths back to a decimal string with exactly 6 fractional digits. */
function fromMicros(value: bigint): string {
  const negative = value < 0n;
  const absValue = negative ? -value : value;
  const whole = absValue / MICROS_PER_UNIT;
  const fraction = (absValue % MICROS_PER_UNIT).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export interface DistributionDeductions {
  grossRentEur: string;
  managementFeeEur: string;
  otherExpensesEur: string;
  reserveHoldbackEur: string;
}

/**
 * gross - fee - expenses - reserve, floored at zero. A property that ran a
 * loss for the period distributes nothing rather than a negative amount —
 * the waterfall has no mechanism for clawing back a prior distribution.
 * Returned as a 2-decimal string, matching distributable_net_eur's
 * NUMERIC(15,2) column — the deductions themselves are staff-entered,
 * genuinely 2-decimal figures.
 */
export function computeDistributableNet(input: DistributionDeductions): string {
  const net =
    toMicros(input.grossRentEur) -
    toMicros(input.managementFeeEur) -
    toMicros(input.otherExpensesEur) -
    toMicros(input.reserveHoldbackEur);
  const floored = net > 0n ? net : 0n;
  // Truncate (not bankers-round) micros down to whole cents: an extra
  // fraction of a cent left undistributed is the safe direction of error,
  // never one that could pay out more than was actually collected.
  const MICROS_PER_CENT = 10_000n;
  const wholeCents = floored / MICROS_PER_CENT;
  const euros = wholeCents / 100n;
  const cents = (wholeCents % 100n).toString().padStart(2, "0");
  return `${euros}.${cents}`;
}

export function computeAmountPerUnit(input: { distributableNetEur: string; totalUnits: string }): string {
  const totalUnitsMicros = toMicros(input.totalUnits);
  if (totalUnitsMicros <= 0n) {
    throw new Error("computeAmountPerUnit: totalUnits must be positive");
  }
  // Scale up before dividing so the division itself happens in micro-of-micro
  // precision, then scale back down -- avoids truncating the division to zero
  // when distributableNetEur is small relative to totalUnits.
  const scaledNet = toMicros(input.distributableNetEur) * MICROS_PER_UNIT;
  const perUnitMicros = scaledNet / totalUnitsMicros;
  return fromMicros(perUnitMicros);
}

export function computeEntryAmount(input: { unitCount: string; amountPerUnitEur: string }): string {
  const scaled = (toMicros(input.unitCount) * toMicros(input.amountPerUnitEur)) / MICROS_PER_UNIT;
  return fromMicros(scaled);
}
