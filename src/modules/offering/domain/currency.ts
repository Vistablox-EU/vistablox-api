export function toCents(value: string): bigint {
  const [euros, fraction = "00"] = value.split(".");
  return BigInt(euros!) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

export function fromCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

export function subtractCurrencyFloorZero(minuend: string, subtrahend: string): string {
  const remaining = toCents(minuend) - toCents(subtrahend);
  return fromCents(remaining > 0n ? remaining : 0n);
}

// EURC is EUR-pegged 1:1 but uses 6-decimal ("micro") on-chain precision,
// unlike the 2-decimal cents this module otherwise deals in (AD-256's escrow
// contract amounts, e.g.).
export function toEurcMicros(value: string): bigint {
  const [euros, fraction = "000000"] = value.split(".");
  return BigInt(euros!) * 1_000_000n + BigInt(fraction.padEnd(6, "0").slice(0, 6));
}

export function fromEurcMicros(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const euros = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${euros}.${fraction}`;
}
