import { AppError } from "../errors/app-error.js";

interface RejectedBody {
  code: string;
  title: string;
  status: number;
  detail: string;
}

export interface BodyParserRejection {
  error: AppError;
  /** What the parser called the failure: its `type`, or a zlib `code`. Safe to log. */
  parserError: string;
}

// express.json() hands next() the errors body-parser and raw-body create with
// http-errors, keyed by `type`. They describe a request the client got wrong,
// so each gets its own 4xx. The detail strings are fixed on purpose: the
// parser's own messages can quote the request body (JSON.parse does), and so
// does the error's `body` property.
const rejectedBodies = new Map<string, RejectedBody>([
  [
    "entity.parse.failed",
    {
      code: "request.invalid_json",
      title: "Request body is not valid JSON",
      status: 400,
      detail: "The request body could not be parsed as a JSON object or array.",
    },
  ],
  [
    "entity.too.large",
    {
      code: "request.payload_too_large",
      title: "Request body too large",
      status: 413,
      detail: "The request body is larger than the API accepts.",
    },
  ],
  [
    "charset.unsupported",
    {
      code: "request.unsupported_charset",
      title: "Unsupported request charset",
      status: 415,
      detail: "The charset of the request body is not supported. Send it as UTF-8.",
    },
  ],
  [
    "encoding.unsupported",
    {
      code: "request.unsupported_encoding",
      title: "Unsupported request content encoding",
      status: 415,
      detail: "The Content-Encoding of the request body is not supported.",
    },
  ],
  [
    "request.aborted",
    {
      code: "request.aborted",
      title: "Request aborted",
      status: 400,
      detail: "The request was aborted before its body was fully received.",
    },
  ],
  [
    "request.size.invalid",
    {
      code: "request.size_mismatch",
      title: "Request size mismatch",
      status: 400,
      detail: "The size of the request body did not match its Content-Length.",
    },
  ],
]);

/**
 * Turns an error from the body parser into the 4xx the client earned, or
 * returns undefined for anything that is not one.
 *
 * The result deliberately has no `cause`: the parser's error carries the
 * request body.
 */
export function translateBodyParserError(error: unknown): BodyParserRejection | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const { type, code, status, expose } = error as Record<string, unknown>;

  if (typeof type === "string") {
    const known = rejectedBodies.get(type);
    if (known !== undefined) {
      return { error: new AppError(known), parserError: type };
    }
  }

  // What is left of the parser's own client errors has no `type`: a body that
  // fails to decompress reaches us as zlib's own error (code Z_DATA_ERROR), to
  // which http-errors added only a status and `expose: true`. http-errors marks
  // only statuses below 500 as exposed.
  if (expose === true && typeof status === "number" && status >= 400 && status < 500) {
    return {
      error: new AppError({
        code: "request.body_rejected",
        title: "Request body rejected",
        status,
        detail: "The request body could not be read.",
      }),
      parserError: typeof code === "string" ? code : "unknown",
    };
  }

  return undefined;
}
