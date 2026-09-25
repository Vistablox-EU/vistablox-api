// Per-action signing requests (contract T1-T3,
// docs/plans/device-bound-auth-backend.md section 3.2/3.4). This module
// holds the *policy* of the signing ceremony: the status machine, the
// `tx` destination/created_by vocabulary, and the field-by-field claims
// comparison that guards confused-deputy signing. It imports no
// infrastructure -- pure decision logic, as the layering rules require of
// domain/.
//
// Status machine (off-chain request types, this phase):
//   pending -> signed -> executed
// with `expired` (past expires_at) and `cancelled` (device revoked /
// recovery started / action aborted) as absorbing stops from pending or
// signed. For off-chain types execution is synchronous with T3, so the
// terminal stored status is `executed` (matching the T3 response literal).
//
// Design-record note: the plan's `auth.signing_requests` section enumerates
// stored statuses as pending/signed/submitted/included/expired/cancelled
// with no `executed`, but T3's off-chain response literal is
// `"submitted"|"executed"`. `submitted`/`included` are on-chain-only (the
// Safe/bundler path, future phases), so off-chain types need their own
// terminal stored status or a completed request would keep reading
// `signed` and stay in the actionable inbox forever. `executed` is that
// status; the on-chain set stays closed in canTransitionSigningRequest.
export const SIGNING_REQUEST_STATUS_PENDING = "pending";
export const SIGNING_REQUEST_STATUS_SIGNED = "signed";
export const SIGNING_REQUEST_STATUS_EXECUTED = "executed";
export const SIGNING_REQUEST_STATUS_SUBMITTED = "submitted";
export const SIGNING_REQUEST_STATUS_INCLUDED = "included";
export const SIGNING_REQUEST_STATUS_EXPIRED = "expired";
export const SIGNING_REQUEST_STATUS_CANCELLED = "cancelled";

export const SIGNING_REQUEST_STATUSES = [
  SIGNING_REQUEST_STATUS_PENDING,
  SIGNING_REQUEST_STATUS_SIGNED,
  SIGNING_REQUEST_STATUS_EXECUTED,
  SIGNING_REQUEST_STATUS_SUBMITTED,
  SIGNING_REQUEST_STATUS_INCLUDED,
  SIGNING_REQUEST_STATUS_EXPIRED,
  SIGNING_REQUEST_STATUS_CANCELLED,
] as const;
export type SigningRequestStatus = (typeof SIGNING_REQUEST_STATUSES)[number];

/** Statuses a client may request via T1's `?status=` filter. */
export const SIGNING_REQUEST_CLIENT_FILTERABLE_STATUSES = [
  SIGNING_REQUEST_STATUS_PENDING,
  SIGNING_REQUEST_STATUS_SIGNED,
  SIGNING_REQUEST_STATUS_EXECUTED,
  SIGNING_REQUEST_STATUS_EXPIRED,
  SIGNING_REQUEST_STATUS_CANCELLED,
] as const;
export type SigningRequestClientFilterableStatus =
  (typeof SIGNING_REQUEST_CLIENT_FILTERABLE_STATUSES)[number];

/** Contract 3.2: `destination` kinds the `tx` claims may name. */
export const TX_DESTINATION_KINDS = ["wallet", "iban", "contract"] as const;
export type TxDestinationKind = (typeof TX_DESTINATION_KINDS)[number];

/** Contract 3.2: `created_by` kinds the `tx` claims may name. */
export const TX_CREATED_BY_KINDS = ["user", "platform", "staff"] as const;
export type TxCreatedByKind = (typeof TX_CREATED_BY_KINDS)[number];

export interface TxDestination {
  kind: TxDestinationKind;
  value: string;
  /**
   * Display-only label the T1 echo may carry for rendering (plan's
   * `destination (jsonb -- {kind, value, display_name})`). Never part of the
   * signed `tx` claims and never compared by compareTxClaimsToRequest: the
   * device signs and the server attests exactly {kind, value}.
   */
  displayName?: string;
}

export interface TxCreatedBy {
  kind: TxCreatedByKind;
  label: string;
}

/**
 * The `tx` JWS claims for an off-chain request type (contract 3.2).
 * `amount_minor` is a decimal string. The device signs exactly these, and
 * the server compares each against the stored request field by field.
 */
export interface TxClaims {
  requestId: string;
  requestType: string;
  amountMinor: string | undefined;
  currency: string | undefined;
  destination: TxDestination | undefined;
  createdBy: TxCreatedBy;
  createdAt: string;
  expiresAt: string;
}

export type TxClaimsComparison =
  | { match: true }
  | { match: false; field: string; expected: string | undefined; provided: string | undefined };

/**
 * Compares a device-signed `tx` claims object against the stored request
 * field by field, as exact strings (contract 3.2: any difference is
 * TX_FIELD_MISMATCH). Dates compare on their ISO-8601 form -- the exact
 * value T1 returned and the device therefore signed, so a nanosecond the
 * client truncated or shifted can't silently pass. destination
 * `name`/`display_name` is display-only (T1) and is never signed nor
 * compared.
 */
export function compareTxClaimsToRequest(
  claims: TxClaims,
  request: {
    id: string;
    requestType: string;
    amountMinor: string | null;
    currency: string | null;
    destination: TxDestination | null;
    createdBy: TxCreatedBy;
    createdAt: Date;
    expiresAt: Date;
  },
): TxClaimsComparison {
  type Field = readonly [field: string, expected: string | undefined, provided: string | undefined];
  const fields: Field[] = [
    ["request_id", request.id, claims.requestId],
    ["request_type", request.requestType, claims.requestType],
    ["amount_minor", request.amountMinor ?? undefined, claims.amountMinor ?? undefined],
    ["currency", request.currency ?? undefined, claims.currency ?? undefined],
    ["destination.kind", request.destination?.kind ?? undefined, claims.destination?.kind ?? undefined],
    ["destination.value", request.destination?.value ?? undefined, claims.destination?.value ?? undefined],
    ["created_by.kind", request.createdBy.kind, claims.createdBy.kind],
    ["created_by.label", request.createdBy.label, claims.createdBy.label],
    ["created_at", request.createdAt.toISOString(), claims.createdAt],
    ["expires_at", request.expiresAt.toISOString(), claims.expiresAt],
  ];
  for (const [field, expected, provided] of fields) {
    if (expected !== provided) {
      return { match: false, field, expected, provided };
    }
  }
  return { match: true };
}

/**
 * Whether the signing status machine permits `from` -> `to`. The repository
 * enforces this atomically (a conditional UPDATE ... WHERE status = <from>),
 * so two racing T3 requests can't both "win"; this predicate is the same
 * rule stated for policy tests and for any code reasoning about transitions.
 */
export function canTransitionSigningRequest(
  from: SigningRequestStatus,
  to: SigningRequestStatus,
): boolean {
  switch (from) {
    case SIGNING_REQUEST_STATUS_PENDING:
      return to === SIGNING_REQUEST_STATUS_SIGNED;
    case SIGNING_REQUEST_STATUS_SIGNED:
      return (
        to === SIGNING_REQUEST_STATUS_EXECUTED ||
        to === SIGNING_REQUEST_STATUS_SUBMITTED ||
        to === SIGNING_REQUEST_STATUS_EXPIRED ||
        to === SIGNING_REQUEST_STATUS_CANCELLED
      );
    case SIGNING_REQUEST_STATUS_SUBMITTED:
      // On-chain only (future phases): none of the other transitions are
      // reachable yet, but the machine stays ready for the bundler path.
      return to === SIGNING_REQUEST_STATUS_INCLUDED;
    // pending -> expired/cancelled (not just -> signed) and all other
    // terminal stops are absorbing.
    default:
      return false;
  }
}

/**
 * A signing request a client is forbidden to still see as actionable. The
 * T1 inbox surfaces pending requests; `signed` only appears after T3 and
 * before a request leaves the over/under-dispatch races.
 */
export function isSigningRequestActionable(status: SigningRequestStatus): boolean {
  return status === SIGNING_REQUEST_STATUS_PENDING || status === SIGNING_REQUEST_STATUS_SIGNED;
}

/** The purpose value the device-auth JWS must carry for a signing action. */
export const SIGNING_JWS_PURPOSE = "tx";

// The request-type vocabulary is deliberately NOT pinned in domain: the
// sensitive routes that shell out to prepare (Phase 2) own their request
// types, and the signing subsystem treats request_type as an opaque label
// it stores, echoes in T1/T4, and signs over. Domain only fixes the generic
// ceremony (statuses, purposes, tx claim comparison), never businesses.

/**
 * Parses and shape-checks the `tx` JWS payload claims (contract 3.2) into
 * the comparator's TxClaims. Returns null on any missing/foreign value
 * rather than throwing: a malformed claim set is a claims problem the
 * signing service reports as TX_FIELD_MISMATCH / TX_SIGNATURE_INVALID, not
 * a crash. Date claims travel as the ISO-8601 strings the device signed.
 */
export function parseTxClaims(claims: Record<string, unknown>): TxClaims | null {
  if (typeof claims.request_id !== "string") return null;
  if (typeof claims.request_type !== "string") return null;
  const amountMinor = claims.amount_minor;
  if (amountMinor !== undefined && amountMinor !== null && typeof amountMinor !== "string") {
    return null;
  }
  const currency = claims.currency;
  if (currency !== undefined && currency !== null && typeof currency !== "string") {
    return null;
  }
  const destination = claims.destination;
  if (destination !== undefined && destination !== null) {
    if (typeof destination !== "object" || Array.isArray(destination)) return null;
    const d = destination as Record<string, unknown>;
    if (typeof d.kind !== "string" || !(TX_DESTINATION_KINDS as readonly string[]).includes(d.kind)) {
      return null;
    }
    if (typeof d.value !== "string") return null;
  }
  const createdBy = claims.created_by;
  if (typeof createdBy !== "object" || createdBy === null || Array.isArray(createdBy)) {
    return null;
  }
  const createdByRecord = createdBy as Record<string, unknown>;
  if (
    typeof createdByRecord.kind !== "string" ||
    !(TX_CREATED_BY_KINDS as readonly string[]).includes(createdByRecord.kind)
  ) {
    return null;
  }
  if (typeof createdByRecord.label !== "string") return null;
  if (typeof claims.created_at !== "string") return null;
  if (typeof claims.expires_at !== "string") return null;

  return {
    requestId: claims.request_id,
    requestType: claims.request_type,
    amountMinor: amountMinor === undefined || amountMinor === null ? undefined : amountMinor,
    currency: currency === undefined || currency === null ? undefined : currency,
    destination:
      destination === undefined || destination === null
        ? undefined
        : {
            kind: (destination as Record<string, unknown>).kind as TxDestinationKind,
            value: (destination as Record<string, unknown>).value as string,
          },
    createdBy: {
      kind: createdByRecord.kind as TxCreatedByKind,
      label: createdByRecord.label,
    },
    createdAt: claims.created_at,
    expiresAt: claims.expires_at,
  };
}