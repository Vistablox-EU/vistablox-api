import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { DeviceAlreadyEnrolledError } from "../application/device-auth-errors.js";
import type { Device, DeviceRepository } from "./device.repository.js";

// This table's two unique constraints (dpop_jkt, and the partial
// one-active-device-per-account index from the
// 20260911160000_device_one_active_per_account migration) both exist to
// close a check-then-insert race EnrolDeviceService's own pre-checks can't
// fully close on their own (findByDpopJkt / findActiveDeviceForAccount, then
// this create() -- two concurrent enrolments can both pass those checks
// before either has inserted). The partial index isn't modeled in
// schema.prisma (Prisma's DSL has no syntax for one), so it surfaces here
// by constraint name rather than target field name.
const ONE_ACTIVE_DEVICE_PER_ACCOUNT_CONSTRAINT = "devices_one_active_per_account";

export class PrismaDeviceRepository implements DeviceRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async create(input: {
    accountId: string;
    betterAuthUserId: string;
    dpopJkt: string;
    bioJkt: string;
    biometricPublicJwk: Record<string, unknown>;
    platform: string;
    model: string | undefined;
    osVersion: string | undefined;
    appVersion: string | undefined;
    attestationMetadata: Record<string, unknown>;
  }): Promise<Device> {
    try {
      const created = await this.database.device.create({
        data: {
          deviceId: `device_${ulid()}`,
          accountId: input.accountId,
          betterAuthUserId: input.betterAuthUserId,
          dpopJkt: input.dpopJkt,
          bioJkt: input.bioJkt,
          biometricPublicJwk: input.biometricPublicJwk as Prisma.InputJsonValue,
          platform: input.platform,
          model: input.model ?? null,
          osVersion: input.osVersion ?? null,
          appVersion: input.appVersion ?? null,
          attestationMetadata: input.attestationMetadata as Prisma.InputJsonValue,
        },
      });
      return toDevice(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        (constraintMatches(error, ONE_ACTIVE_DEVICE_PER_ACCOUNT_CONSTRAINT) ||
          constraintMatches(error, "dpop_jkt"))
      ) {
        // Contract 3.6: DEVICE_ALREADY_ENROLLED (409) for both -- see that
        // error class's own doc comment for why this table's two unique
        // constraints share one code/status.
        throw new DeviceAlreadyEnrolledError();
      }
      throw error;
    }
  }

  public async findByDeviceId(deviceId: string): Promise<Device | null> {
    const found = await this.database.device.findUnique({ where: { deviceId } });
    return found === null ? null : toDevice(found);
  }

  public async findByDpopJkt(dpopJkt: string): Promise<Device | null> {
    const found = await this.database.device.findUnique({ where: { dpopJkt } });
    return found === null ? null : toDevice(found);
  }

  public async findActiveDeviceForAccount(accountId: string): Promise<Device | null> {
    const found = await this.database.device.findFirst({
      where: { accountId, status: "active" },
      orderBy: { createdAt: "asc" },
    });
    return found === null ? null : toDevice(found);
  }

  public async touchLastSeen(deviceId: string, at: Date): Promise<void> {
    await this.database.device.update({
      where: { deviceId },
      data: { lastSeenAt: at },
    });
  }

  public async delete(deviceId: string): Promise<void> {
    // deleteMany, not delete: a no-op on an id that's already gone must not
    // throw (P2025) -- this is compensation logic, called from a catch
    // block that's about to rethrow the real error either way.
    await this.database.device.deleteMany({ where: { deviceId } });
  }
}

// meta.target's shape depends on whether Prisma recognizes the violated
// constraint from schema.prisma: a string[] of field names for one it
// knows (dpop_jkt), or just the constraint name as a bare string for one
// it doesn't (the hand-written partial index) -- checking both, plus the
// underlying Postgres error message as a fallback, covers either case
// without depending on exactly which one a given Prisma/driver version
// picks.
function constraintMatches(
  error: Prisma.PrismaClientKnownRequestError,
  constraintOrFieldName: string,
): boolean {
  const target = error.meta?.target;
  if (typeof target === "string" && target.includes(constraintOrFieldName)) return true;
  if (Array.isArray(target) && target.some((field) => String(field).includes(constraintOrFieldName))) {
    return true;
  }
  return error.message.includes(constraintOrFieldName);
}

interface PrismaDeviceRow {
  deviceId: string;
  accountId: string;
  betterAuthUserId: string;
  dpopJkt: string;
  bioJkt: string;
  biometricPublicJwk: unknown;
  platform: string;
  status: string;
  createdAt: Date;
  lastSeenAt: Date;
}

function toDevice(row: PrismaDeviceRow): Device {
  return {
    deviceId: row.deviceId,
    accountId: row.accountId,
    betterAuthUserId: row.betterAuthUserId,
    dpopJkt: row.dpopJkt,
    bioJkt: row.bioJkt,
    biometricPublicJwk: row.biometricPublicJwk as Record<string, unknown>,
    platform: row.platform,
    status: row.status,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}
