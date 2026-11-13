import { getAddress, isAddress } from "viem";

// One spelling of an EVM address is stored, compared and returned everywhere
// in the API: "0x" followed by 40 lowercase hex digits, no surrounding
// whitespace. This is deliberately not EIP-55 (mixed-case checksum) spelling.
// Postgres TEXT equality is case-sensitive, so only a single stored spelling
// makes "one address, one account" hold in the database, and a keccak checksum
// is something a CHECK constraint cannot compute.
//
// This function does not validate. "0X..." becomes "0x...", so the shape check
// (the wallet.schemas.ts regex, which runs first and is case-sensitive about
// the prefix) must stay in front of it wherever input comes from a client.
export function canonicalWalletAddress(value: string): string {
  return value.trim().toLowerCase();
}

// EIP-55 spelling for the one outbound caller that is shown addresses in that
// form today (Coinbase onramp). Input that is not a valid address is returned
// unchanged, so a bad value surfaces as the provider's error instead of a
// throw from here. Strict checksum validation is off on purpose: the value is
// usually the canonical lowercase form, which carries no checksum to verify.
export function toChecksumWalletAddress(value: string): string {
  return isAddress(value, { strict: false }) ? getAddress(value) : value;
}
