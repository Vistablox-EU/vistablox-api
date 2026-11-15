/**
 * Contract 3.6 codes for the signing-request lifecycle (T1-T3).
 * Domain-layer policy decides (status machines, claim comparison); these
 * become wire codes via the router's envelope. The status mapping mirrors
 * the "Transaction signing" risks (lines 488-492 of the plan): confused-
 * deputy is caught by TX_FIELD_MISMATCH, replay by REQUEST_ALREADY_CONSUMED,
 * cross-device signing by TX_WRONG_DEVICE.
 */

export class SigningRequestNotFoundError extends Error {
  public readonly code = "SIGNING_REQUEST_NOT_FOUND" as const;
  public constructor() {
    super("No signing request exists for this account and id.");
    this.name = "SigningRequestNotFoundError";
  }
}

/** Contract: REQUEST_EXPIRED (409) -- past expires_at, status pruned or not. */
export class SigningRequestExpiredError extends Error {
  public readonly code = "REQUEST_EXPIRED" as const;
  public constructor() {
    super("This signing request has expired.");
    this.name = "SigningRequestExpiredError";
  }
}

/** Contract: REQUEST_CANCELLED (409) -- device revoked / recovery started. */
export class SigningRequestCancelledError extends Error {
  public readonly code = "REQUEST_CANCELLED" as const;
  public constructor() {
    super("This signing request was cancelled.");
    this.name = "SigningRequestCancelledError";
  }
}

/**
 * Contract: REQUEST_ALREADY_CONSUMED (409) -- the request was already signed
 * (or for on-chain types submitted). A re-submission of T3 must never re-run
 * the ceremony; the single-use challenge plus the atomic status transition
 * already stopped it, and this is the honest code for a request that is a
 * terminal, non-cancellable state reached before expiry.
 */
export class SigningRequestAlreadyConsumedError extends Error {
  public readonly code = "REQUEST_ALREADY_CONSUMED" as const;
  public constructor() {
    super("This signing request was already signed.");
    this.name = "SigningRequestAlreadyConsumedError";
  }
}

/**
 * Contract: TX_WRONG_DEVICE (403). The session's DPoP key and the request's
 * device must resolve to the same device record -- a device with an active
 * session may not sign another device's request (plan line 492).
 */
export class TxWrongDeviceError extends Error {
  public readonly code = "TX_WRONG_DEVICE" as const;
  public constructor() {
    super("The session's device is not this request's signing device.");
    this.name = "TxWrongDeviceError";
  }
}

/** Contract: TX_SIGNATURE_INVALID (401) -- the off-chain `tx` JWS failed. */
export class TxSignatureInvalidError extends Error {
  public readonly code = "TX_SIGNATURE_INVALID" as const;
  public constructor(reason: string) {
    super(`The transaction JWS was rejected: ${reason}.`);
    this.name = "TxSignatureInvalidError";
  }
}

/** Contract: TX_FIELD_MISMATCH (409) -- a `tx` claim differs from the request. */
export class TxFieldMismatchError extends Error {
  public readonly code = "TX_FIELD_MISMATCH" as const;
  public constructor(
    public readonly field: string,
    public readonly expected: string | undefined,
    public readonly provided: string | undefined,
  ) {
    super(`The signed request's ${field} does not match the stored request.`);
    this.name = "TxFieldMismatchError";
  }
}