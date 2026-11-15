// Helpers that keep secrets and personal identifiers out of log lines and out
// of the error text pg-boss stores as a failed job's output. Imports nothing,
// so any layer (including a domain-pure caller's neighbours) can use them.

const URL_PLACEHOLDER = "[url]";

// A scheme-prefixed URL: letters first, then letters/digits/+/./-, then "://".
// file:// is left alone because a stack frame such as
// "file:///app/dist/worker.js:12:3" is a path, not a credential, and keeping
// it is what makes a redacted stack still readable. The character class stops
// at whitespace, quotes, angle brackets and closing brackets so surrounding
// prose survives. Only scheme-prefixed URLs are recognised: a bare
// "host:5432" (for example in "connect ECONNREFUSED 10.0.0.1:5432") is not.
const URL_PATTERN = /\b(?!file:)[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`)\]}]+/gi;

/**
 * Replaces every scheme-prefixed URL in `text` with "[url]". An RPC provider
 * URL carries its API key in the path or query string, and a viem
 * HttpRequestError repeats that URL in its message, stack and metadata, so an
 * error logged or stored as-is would leak the key. Idempotent.
 */
export function stripUrls(text: string): string {
  return text.replace(URL_PATTERN, URL_PLACEHOLDER);
}

const MASKABLE_HEX = /^0x[0-9a-f]{8,}$/;

/**
 * Masks a 0x-prefixed hex identifier (a 40-hex wallet address or a 64-hex
 * commitment) as its first six characters, an ellipsis and its last four:
 * "0xabcd...ef01". Enough to correlate two log lines, not enough to look the
 * value up; the account id is the join key for anything that needs the real
 * one. The value is trimmed and lower-cased inline (the shared address helper
 * is deliberately not imported). Anything that is not a plausible hex
 * identifier yields "[invalid]" and is never echoed, so a malformed or
 * hostile on-chain value cannot be smuggled into a log line through this.
 */
export function maskHexIdentifier(value: unknown): string {
  if (typeof value !== "string") return "[invalid]";
  const normalised = value.trim().toLowerCase();
  if (!MASKABLE_HEX.test(normalised)) return "[invalid]";
  return `${normalised.slice(0, 6)}...${normalised.slice(-4)}`;
}

// A wallet address is 40 hex digits and a commitment (or a transaction hash)
// 64; shorter 0x values (a method selector, a block number) are not identifiers.
const LONG_HEX_VALUE = /0x[0-9a-fA-F]{40,}/g;

/**
 * Replaces every 0x-prefixed run of 40 or more hex digits in free text with its
 * masked form (see maskHexIdentifier). For error text, which this module cannot
 * vouch for: a database unique-violation message or an RPC request body can
 * carry a wallet address or commitment verbatim.
 */
export function maskLongHexValues(text: string): string {
  return text.replace(LONG_HEX_VALUE, (match) => maskHexIdentifier(match));
}

/**
 * A copy of `error` that is safe to log, to rethrow into pg-boss and to
 * store: the name is kept, the message and stack have their URLs stripped and
 * their long hex values masked, and nothing else is carried over. In
 * particular there is no `cause` and no own property, because pg-boss
 * serialises a thrown error with serialize-error and a viem error's url,
 * headers and body properties would otherwise end up in the job's stored
 * output.
 */
export function toSanitizedError(error: unknown): Error {
  const clean = (text: string) => maskLongHexValues(stripUrls(text));
  if (!(error instanceof Error)) {
    return new Error(clean(typeof error === "string" ? error : "non-error value thrown"));
  }
  const sanitized = new Error(clean(error.message));
  sanitized.name = error.name;
  if (typeof error.stack === "string") sanitized.stack = clean(error.stack);
  return sanitized;
}
