import type { SerializedRequest } from "pino";

const CENSOR = "[REDACTED]";

// Query parameter names whose value is never logged, whatever it looks like.
// Names are compared lower-cased with `_`, `-` and `.` removed, so
// `access_token`, `accessToken` and `Access-Token` compare equal. A stem
// matches anywhere in the name (`contact_email`, `reset_token`); the generic
// words below would also hit `country_code` or `statement`, so they must match
// the whole name.
const SENSITIVE_NAME_STEMS = [
  "email",
  "phone",
  "token",
  "password",
  "passwd",
  "secret",
  "signature",
  "apikey",
  "authorization",
  "assertion",
  "challenge",
  "dpop",
];
const SENSITIVE_WHOLE_NAMES = new Set([
  "code",
  "state",
  "otp",
  "key",
  "name",
  "givenname",
  "familyname",
  "fullname",
  "fulldisplayname",
]);

function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[_.-]/g, "");
  return (
    SENSITIVE_WHOLE_NAMES.has(normalized) ||
    SENSITIVE_NAME_STEMS.some((stem) => normalized.includes(stem))
  );
}

function decodeComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// A deny-list cannot name every parameter an email might arrive under, so a
// value is also masked when it carries an `@` at all. That includes a
// half-typed address ("jane.doe@") and an address inside a longer value; in
// this API's query strings an `@` is only ever an email or part of one. The
// `%40` test covers a value whose percent-encoding is malformed and so
// cannot be decoded.
function containsAtSign(raw: string): boolean {
  return decodeComponent(raw).includes("@") || /%40/i.test(raw);
}

function redactPair(pair: string): string {
  const separator = pair.indexOf("=");
  const rawName = separator === -1 ? pair : pair.slice(0, separator);
  if (containsAtSign(rawName)) {
    return CENSOR;
  }
  if (separator === -1) {
    return pair;
  }
  const rawValue = pair.slice(separator + 1);
  return isSensitiveName(decodeComponent(rawName)) || containsAtSign(rawValue)
    ? `${rawName}=${CENSOR}`
    : pair;
}

/** Masks the sensitive values in a raw query string (without the leading `?`), leaving everything else byte for byte. */
export function redactQueryString(query: string): string {
  return query.split("&").map(redactPair).join("&");
}

/** Masks the query string of a request target such as `req.originalUrl`; the path is left as it is. */
export function redactUrl(url: string): string {
  const start = url.indexOf("?");
  return start === -1 ? url : `${url.slice(0, start + 1)}${redactQueryString(url.slice(start + 1))}`;
}

function redactQueryValue(name: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactQueryValue(name, item));
  }
  if (isSensitiveName(name)) {
    return CENSOR;
  }
  if (typeof value === "object" && value !== null) {
    return redactQueryObject(value);
  }
  return typeof value === "string" && value.includes("@") ? CENSOR : value;
}

/** The parsed counterpart of `redactQueryString`, for the `req.query` object pino-http logs next to the url. Returns a copy. */
export function redactQueryObject(query: unknown): unknown {
  if (typeof query !== "object" || query === null) {
    return query;
  }
  return Object.fromEntries(
    Object.entries(query).map(([name, value]) =>
      // As in redactPair, a name that is itself an email takes its value with it.
      name.includes("@") ? [CENSOR, CENSOR] : [name, redactQueryValue(name, value)],
    ),
  );
}

/**
 * Request serializer for pino-http. It runs on the already serialized request
 * and changes only `url` and `query`, which carry whatever the client put in
 * the query string (the staff account search puts a customer's email there).
 * The headers are not touched here: the logger's `redact` paths censor those.
 */
export function requestLogSerializer(request: SerializedRequest): SerializedRequest {
  const redacted = { ...request, url: redactUrl(request.url) };
  if (request.query !== undefined) {
    redacted.query = redactQueryObject(request.query) as SerializedRequest["query"];
  }
  return redacted;
}
