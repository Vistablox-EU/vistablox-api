import { describe, expect, it } from "vitest";

import { Prisma } from "../src/generated/prisma/client.js";
import { isUniqueViolationOf } from "../src/infrastructure/database/unique-violation.js";

const INDEX = "uq_wallet_registrations_chain_event";

function knownError(code: string, message: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "test",
    ...(meta === undefined ? {} : { meta }),
  });
}

describe("isUniqueViolationOf", () => {
  it("recognizes the index name the pg driver adapter reports for a raw-SQL partial index", () => {
    const error = knownError("P2002", "Unique constraint failed on the (not available)", {
      driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index: INDEX } } },
    });
    expect(isUniqueViolationOf(error, INDEX)).toBe(true);
  });

  it("recognizes the name in meta.target, as a string and as a list", () => {
    expect(isUniqueViolationOf(knownError("P2002", "x", { target: INDEX }), INDEX)).toBe(true);
    expect(
      isUniqueViolationOf(knownError("P2002", "x", { target: ["registration_tx_hash", INDEX] }), INDEX),
    ).toBe(true);
  });

  it("falls back to the message when no meta carries the name", () => {
    expect(isUniqueViolationOf(knownError("P2002", `duplicate key value violates unique constraint "${INDEX}"`), INDEX)).toBe(true);
  });

  it("is false for a unique violation of a different constraint", () => {
    const error = knownError("P2002", "Unique constraint failed", {
      driverAdapterError: { cause: { constraint: { index: "wallet_registrations_confirmed_address_key" } } },
      target: ["wallet_registrations_confirmed_address_key"],
    });
    expect(isUniqueViolationOf(error, INDEX)).toBe(false);
  });

  it("is false for another Prisma error code carrying the same name", () => {
    expect(isUniqueViolationOf(knownError("P2010", `raw query failed: ${INDEX}`, { target: INDEX }), INDEX)).toBe(false);
  });

  it("is false for errors that are not Prisma errors", () => {
    expect(isUniqueViolationOf(new Error(INDEX), INDEX)).toBe(false);
    expect(isUniqueViolationOf(null, INDEX)).toBe(false);
    expect(isUniqueViolationOf(undefined, INDEX)).toBe(false);
    expect(isUniqueViolationOf(INDEX, INDEX)).toBe(false);
  });
});
