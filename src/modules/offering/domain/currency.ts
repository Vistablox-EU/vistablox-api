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
