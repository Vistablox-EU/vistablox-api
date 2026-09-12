import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { DeviceAlreadyEnrolledError, DeviceChallengeExpiredError } from "../application/device-auth-errors.js";
import { ENROLMENT_INSERT_DEADLINE_MS } from "../domain/device-challenge-replay.js";
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

// auth.login_methods.method_type for an enrolled device's biometric key.
// provider_subject holds the device_id.
const DEVICE_KEY_LOGIN_METHOD = "device_key";

export interface PrismaDeviceRepositoryOptions {
  /**
   * Test seam only: runs inside create()'s transaction, after the insert
   * deadline check and before the insert, to simulate the API stalling
   * there. Never set in production wiring.
   */
  afterDeadlineCheck?: () => Promise<void>;
}

export class PrismaDeviceRepository implements DeviceRepository {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly options: PrismaDeviceRepositoryOptions = {},
  ) {}

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
    consumedChallenge: { challenge: string; purpose: string; dpopJkt: string };
  }): Promise<Device> {
    const consumed = input.consumedChallenge;
    try {
      const created = await this.database.$transaction(
        async (tx) => {
          // The insert deadline (domain/device-challenge-replay.ts) is checked
          // on the database clock below. These bound how long this
          // transaction can stay open after that check -- running, waiting
          // for a lock, or idle before COMMIT -- all far under the 60 s
          // between the deadline and the replay window. Hitting any of them
          // aborts the transaction: nothing is registered.
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
          await tx.$executeRaw`SET LOCAL idle_in_transaction_session_timeout = '5s'`;
          // clock_timestamp(), not now(): the time of this check itself, not
          // of BEGIN. FOR SHARE holds the challenge row until this
          // transaction ends, so pruning can't delete it between this check
          // and the insert's commit: a replay can never find neither the
          // challenge nor the device while the device is still committing.
          const rows = await tx.$queryRaw<Array<{ fresh: number }>>`
            SELECT 1 AS fresh
            FROM auth.device_challenges
            WHERE challenge = ${consumed.challenge}
              AND purpose = ${consumed.purpose}
              AND dpop_jkt = ${consumed.dpopJkt}
              AND consumed_at > clock_timestamp() - (${ENROLMENT_INSERT_DEADLINE_MS}::integer * interval '1 millisecond')
            FOR SHARE
          `;
          if (rows.length === 0) {
            throw new DeviceChallengeExpiredError();
          }
          await this.options.afterDeadlineCheck?.();
          const device = await tx.device.create({
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
          // The enrolled device is one of the account's login methods, in
          // the same transaction as the device row: both commit or neither
          // does. One device_key row per account (unique on account and
          // method), pointing at the current device.
          await tx.loginMethod.upsert({
            where: {
              accountId_methodType: { accountId: input.accountId, methodType: DEVICE_KEY_LOGIN_METHOD },
            },
            create: {
              id: `login_${ulid()}`,
              accountId: input.accountId,
              methodType: DEVICE_KEY_LOGIN_METHOD,
              providerSubject: device.deviceId,
              linkedAt: device.createdAt,
              linkedViaFreshAuth: true,
            },
            update: {
              providerSubject: device.deviceId,
              linkedAt: device.createdAt,
              linkedViaFreshAuth: true,
            },
          });
          return device;
        },
        // Client-side limits: waiting for a connection happens before the
        // deadline check, and a transaction past `timeout` is rolled back.
        { maxWait: 5_000, timeout: 10_000 },
      );
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
    // block that's about to rethrow the real error either way. The device's
    // login method goes with it, in one transaction; only the row pointing
    // at this device, never one for another device of the account.
    await this.database.$transaction([
      this.database.loginMethod.deleteMany({
        where: { methodType: DEVICE_KEY_LOGIN_METHOD, providerSubject: deviceId },
      }),
      this.database.device.deleteMany({ where: { deviceId } }),
    ]);
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
