import { Prisma } from "../../generated/prisma/client.js";

/**
 * True when `error` is a Prisma unique violation (P2002) of the named
 * constraint or index.
 *
 * Checking the name matters: one UPDATE can run into more than one unique
 * constraint, and an unrelated one (another account's address claim, say) must
 * not be mistaken for the one the caller handles.
 *
 * Where the name sits depends on what Prisma knows about the index. For a
 * constraint declared in schema.prisma, `meta.target` carries the field names or
 * the name. For a partial index created in raw SQL (which Prisma cannot model),
 * Prisma 7 with the pg adapter leaves `meta.target` empty and the name is only
 * in `meta.driverAdapterError.cause.constraint.index` and in the message. All
 * three places are checked, so the answer does not depend on which one a given
 * Prisma or driver version fills in.
 */
export function isUniqueViolationOf(error: unknown, constraintName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const meta = error.meta as
    | { target?: unknown; driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } }
    | undefined;
  const driverIndex = meta?.driverAdapterError?.cause?.constraint?.index;
  if (typeof driverIndex === "string" && driverIndex === constraintName) return true;
  const target = meta?.target;
  if (typeof target === "string" && target.includes(constraintName)) return true;
  if (Array.isArray(target) && target.some((field) => String(field).includes(constraintName))) return true;
  return error.message.includes(constraintName);
}
