import { Prisma } from "../../generated/prisma/client.js";

/**
 * True when `error` is Postgres' unique_violation (SQLSTATE 23505) raised by
 * the named constraint or index.
 *
 * Prisma reports the same database error under two codes depending on the call
 * that hit it: P2002 for a typed call such as `updateMany`, and P2010 for a raw
 * statement such as `$executeRaw`. Both carry the driver adapter's error under
 * `meta.driverAdapterError`, with the violated constraint in `cause.constraint`
 * (`index` for a unique index, `name` for a constraint). A partial or expression
 * index that schema.prisma cannot describe has no `meta.target` field list, so
 * the name is the only reliable key; the message is the last-resort fallback,
 * the same way `constraintMatches` in prisma-device.repository.ts treats it.
 */
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== "P2002" && error.code !== "P2010") return false;

  const cause = readDriverCause(error.meta);
  if (cause !== undefined) {
    if (cause.originalCode !== undefined && cause.originalCode !== "23505") return false;
    if (cause.constraint?.index === constraintName || cause.constraint?.name === constraintName) {
      return true;
    }
  }
  if (error.code === "P2002") {
    const target = error.meta?.["target"];
    if (typeof target === "string" && target === constraintName) return true;
    if (Array.isArray(target) && target.some((entry) => entry === constraintName)) return true;
  }
  return error.message.includes(constraintName);
}

interface DriverCause {
  originalCode?: string;
  constraint?: { index?: string; name?: string };
}

function readDriverCause(meta: unknown): DriverCause | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const driverAdapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof driverAdapterError !== "object" || driverAdapterError === null) return undefined;
  const cause = (driverAdapterError as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  return cause as DriverCause;
}
