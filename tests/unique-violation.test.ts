import { describe, expect, it } from "vitest";

import { Prisma } from "../src/generated/prisma/client.js";
import { isUniqueViolation } from "../src/infrastructure/database/unique-violation.js";

const INDEX = "wallet_registrations_confirmed_address_key";

function prismaError(code: string, meta: Record<string, unknown>, message = "database error"): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: "test", meta });
}

function driverMeta(originalCode: string, constraint: Record<string, string>): Record<string, unknown> {
  return { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode, kind: "UniqueConstraintViolation", constraint } } };
}

describe("isUniqueViolation", () => {
  it("recognises a typed-call violation (P2002) by the index the driver reports", () => {
    expect(isUniqueViolation(prismaError("P2002", driverMeta("23505", { index: INDEX })), INDEX)).toBe(true);
  });

  it("recognises a raw-statement violation (P2010) by the index the driver reports", () => {
    expect(isUniqueViolation(prismaError("P2010", driverMeta("23505", { index: INDEX })), INDEX)).toBe(true);
  });

  it("recognises a named constraint as well as an index", () => {
    expect(isUniqueViolation(prismaError("P2002", driverMeta("23505", { name: INDEX })), INDEX)).toBe(true);
  });

  it("falls back to meta.target and then to the message when the driver gives no constraint", () => {
    expect(isUniqueViolation(prismaError("P2002", { target: INDEX }), INDEX)).toBe(true);
    expect(isUniqueViolation(prismaError("P2002", { target: ["wallet_address"] }), "wallet_address")).toBe(true);
    expect(isUniqueViolation(prismaError("P2010", {}, `duplicate key value violates unique constraint "${INDEX}"`), INDEX)).toBe(true);
  });

  it("is false for a different constraint", () => {
    expect(isUniqueViolation(prismaError("P2002", driverMeta("23505", { index: "wallet_registrations_pkey" })), INDEX)).toBe(false);
  });

  it("is false for another SQLSTATE even when the constraint name matches", () => {
    expect(isUniqueViolation(prismaError("P2002", driverMeta("23503", { index: INDEX })), INDEX)).toBe(false);
  });

  it("is false for another Prisma error code", () => {
    expect(isUniqueViolation(prismaError("P2025", driverMeta("23505", { index: INDEX })), INDEX)).toBe(false);
  });

  it("is false for a plain error, a string and null", () => {
    expect(isUniqueViolation(new Error(`unique violation on ${INDEX}`), INDEX)).toBe(false);
    expect(isUniqueViolation(INDEX, INDEX)).toBe(false);
    expect(isUniqueViolation(null, INDEX)).toBe(false);
  });
});
