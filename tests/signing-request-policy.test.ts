import { describe, expect, it } from "vitest";

import {
  SIGNING_REQUEST_STATUS_CANCELLED,
  SIGNING_REQUEST_STATUS_EXECUTED,
  SIGNING_REQUEST_STATUS_EXPIRED,
  SIGNING_REQUEST_STATUS_INCLUDED,
  SIGNING_REQUEST_STATUS_PENDING,
  SIGNING_REQUEST_STATUS_SIGNED,
  SIGNING_REQUEST_STATUS_SUBMITTED,
  canTransitionSigningRequest,
  compareTxClaimsToRequest,
  isSigningRequestActionable,
  parseTxClaims,
  type TxClaims,
} from "../src/modules/auth/domain/signing-request.policy.js";

function request(overrides: Partial<Parameters<typeof compareTxClaimsToRequest>[1]> = {}) {
  return {
    id: "req_test",
    requestType: "reservation_reconfirm",
    amountMinor: "125000",
    currency: "EUR",
    destination: { kind: "iban" as const, value: "DE89370400440532013000" },
    createdBy: { kind: "user" as const, label: "Damir" },
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    expiresAt: new Date("2026-09-01T10:05:00.000Z"),
    ...overrides,
  };
}

function claims(overrides: Partial<TxClaims> = {}): TxClaims {
  return {
    requestId: "req_test",
    requestType: "reservation_reconfirm",
    amountMinor: "125000",
    currency: "EUR",
    destination: { kind: "iban", value: "DE89370400440532013000" },
    createdBy: { kind: "user", label: "Damir" },
    createdAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-09-01T10:05:00.000Z",
    ...overrides,
  };
}

describe("canTransitionSigningRequest", () => {
  it("allows pending -> signed only", () => {
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_PENDING, SIGNING_REQUEST_STATUS_SIGNED)).toBe(true);
    expect(
      canTransitionSigningRequest(SIGNING_REQUEST_STATUS_PENDING, SIGNING_REQUEST_STATUS_EXECUTED),
    ).toBe(false);
  });

  it("allows signed -> executed/submitted/expired/cancelled (off-chain completes via executed)", () => {
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_SIGNED, SIGNING_REQUEST_STATUS_EXECUTED)).toBe(true);
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_SIGNED, SIGNING_REQUEST_STATUS_SUBMITTED)).toBe(true);
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_SIGNED, SIGNING_REQUEST_STATUS_EXPIRED)).toBe(true);
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_SIGNED, SIGNING_REQUEST_STATUS_CANCELLED)).toBe(true);
  });

  it("keeps on-chain transitions closed and terminal states absorbing", () => {
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_SUBMITTED, SIGNING_REQUEST_STATUS_INCLUDED)).toBe(true);
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_EXECUTED, SIGNING_REQUEST_STATUS_EXPIRED)).toBe(false);
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_EXPIRED, SIGNING_REQUEST_STATUS_PENDING)).toBe(false);
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_CANCELLED, SIGNING_REQUEST_STATUS_PENDING)).toBe(false);
    expect(canTransitionSigningRequest(SIGNING_REQUEST_STATUS_INCLUDED, SIGNING_REQUEST_STATUS_EXECUTED)).toBe(false);
  });
});

describe("isSigningRequestActionable", () => {
  it("treats pending and signed as actionable, terminals as not", () => {
    expect(isSigningRequestActionable(SIGNING_REQUEST_STATUS_PENDING)).toBe(true);
    expect(isSigningRequestActionable(SIGNING_REQUEST_STATUS_SIGNED)).toBe(true);
    expect(isSigningRequestActionable(SIGNING_REQUEST_STATUS_EXECUTED)).toBe(false);
    expect(isSigningRequestActionable(SIGNING_REQUEST_STATUS_EXPIRED)).toBe(false);
    expect(isSigningRequestActionable(SIGNING_REQUEST_STATUS_CANCELLED)).toBe(false);
  });
});

describe("compareTxClaimsToRequest", () => {
  it("matches exactly when claims equal the stored request", () => {
    expect(compareTxClaimsToRequest(claims(), request())).toEqual({ match: true });
  });

  it("reports a mismatch with the exact ISO dates when the client shifts expires_at", () => {
    const result = compareTxClaimsToRequest(claims({ expiresAt: "2026-09-01T10:05:00.999Z" }), request());
    expect(result.match).toBe(false);
    if (result.match) return;
    expect(result.field).toBe("expires_at");
    expect(result.expected).toBe("2026-09-01T10:05:00.000Z");
    expect(result.provided).toBe("2026-09-01T10:05:00.999Z");
  });

  it("rejects a claim for a different request (confused-deputy)", () => {
    const result = compareTxClaimsToRequest(claims({ requestId: "req_another" }), request());
    expect(result).toEqual({
      match: false,
      field: "request_id",
      expected: "req_test",
      provided: "req_another",
    });
  });

  it("rejects a signed amount different from the stored one", () => {
    const result = compareTxClaimsToRequest(claims({ amountMinor: "125001" }), request());
    expect(result).toEqual({ match: false, field: "amount_minor", expected: "125000", provided: "125001" });
  });

  it("compares destination kind and value but never display_name", () => {
    const stored = request({ destination: { kind: "iban", value: "DE89370400440532013000", displayName: "Damir's IBAN" } });
    // The claims destination never carries display_name (contract 3.2), so it
    // must not be compared -- the stored display label is render-only.
    expect(compareTxClaimsToRequest(claims(), stored)).toEqual({ match: true });
  });

  it("rejects a destination value mismatch", () => {
    const result = compareTxClaimsToRequest(
      claims({ destination: { kind: "iban", value: "DE89370400440532013999" } }),
      request(),
    );
    expect(result.match).toBe(false);
  });

  it("rejects a created_by label mismatch", () => {
    const result = compareTxClaimsToRequest(claims({ createdBy: { kind: "user", label: "Not Damir" } }), request());
    expect(result).toEqual({ match: false, field: "created_by.label", expected: "Damir", provided: "Not Damir" });
  });

  it("rejects null-vs-absent mismatches for optional fields", () => {
    const result = compareTxClaimsToRequest(
      claims({ amountMinor: undefined }),
      request({ amountMinor: "125000" }),
    );
    expect(result).toEqual({ match: false, field: "amount_minor", expected: "125000", provided: undefined });
  });
});

describe("parseTxClaims", () => {
  it("parses a well-formed claim set", () => {
    expect(
      parseTxClaims({
        request_id: "req_test",
        request_type: "reservation_reconfirm",
        amount_minor: "125000",
        currency: "EUR",
        destination: { kind: "iban", value: "DE89370400440532013000" },
        created_by: { kind: "user", label: "Damir" },
        created_at: "2026-09-01T10:00:00.000Z",
        expires_at: "2026-09-01T10:05:00.000Z",
      }),
    ).toEqual(claims());
  });

  it("parses a claim set with no optional money fields", () => {
    const parsed = parseTxClaims({
      request_id: "req_test",
      request_type: "device_remove",
      destination: { kind: "wallet", value: "0xabc" },
      created_by: { kind: "platform", label: "VistaBlox" },
      created_at: "2026-09-01T10:00:00.000Z",
      expires_at: "2026-09-01T10:05:00.000Z",
    });
    expect(parsed?.amountMinor).toBeUndefined();
    expect(parsed?.currency).toBeUndefined();
    expect(parsed?.destination).toEqual({ kind: "wallet", value: "0xabc" });
  });

  it("rejects a number amount_minor where a string is required", () => {
    expect(
      parseTxClaims({
        request_id: "req_test",
        request_type: "reservation_reconfirm",
        amount_minor: 125000,
        created_by: { kind: "user", label: "Damir" },
        created_at: "2026-09-01T10:00:00.000Z",
        expires_at: "2026-09-01T10:05:00.000Z",
      }),
    ).toBeNull();
  });

  it("rejects an unknown destination kind", () => {
    expect(
      parseTxClaims({
        request_id: "req_test",
        request_type: "reservation_reconfirm",
        destination: { kind: "crypto", value: "0xabc" },
        created_by: { kind: "user", label: "Damir" },
        created_at: "2026-09-01T10:00:00.000Z",
        expires_at: "2026-09-01T10:05:00.000Z",
      }),
    ).toBeNull();
  });

  it("rejects a missing created_by label", () => {
    expect(
      parseTxClaims({
        request_id: "req_test",
        request_type: "reservation_reconfirm",
        created_by: { kind: "user" },
        created_at: "2026-09-01T10:00:00.000Z",
        expires_at: "2026-09-01T10:05:00.000Z",
      }),
    ).toBeNull();
  });
});