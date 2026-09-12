import { describe, expect, it, vi } from "vitest";

import { Prisma } from "../src/generated/prisma/client.js";
import {
  DeviceAlreadyEnrolledError,
  DeviceChallengeExpiredError,
} from "../src/modules/auth/application/device-auth-errors.js";
import { PrismaDeviceRepository } from "../src/modules/auth/repository/prisma-device.repository.js";
import type { DatabaseClient } from "../src/infrastructure/database/prisma.js";

const CREATE_INPUT = {
  accountId: "account-1",
  betterAuthUserId: "user-1",
  dpopJkt: "dpop-jkt-1",
  bioJkt: "bio-jkt-1",
  biometricPublicJwk: { kty: "EC" },
  platform: "android",
  model: undefined,
  osVersion: undefined,
  appVersion: undefined,
  attestationMetadata: {},
  consumedChallenge: { challenge: "enrol-challenge-1", purpose: "enrol-device", dpopJkt: "dpop-jkt-1" },
};

const CREATED_ROW = {
  deviceId: "device_1",
  accountId: "account-1",
  betterAuthUserId: "user-1",
  dpopJkt: "dpop-jkt-1",
  bioJkt: "bio-jkt-1",
  biometricPublicJwk: { kty: "EC" },
  platform: "android",
  status: "active",
  createdAt: new Date(),
  lastSeenAt: new Date(),
};

function p2002(constraintOrTarget: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${constraintOrTarget}\``,
    { code: "P2002", clientVersion: "test", meta: { target: constraintOrTarget } },
  );
}

// create() runs one transaction: the Postgres timeouts, then the insert
// deadline checked on the database clock, then the insert.
function fakeDatabase(createImpl: () => unknown, options: { challengeFresh?: boolean } = {}) {
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue(options.challengeFresh === false ? [] : [{ fresh: 1 }]),
    device: { create: vi.fn(createImpl) },
  };
  const database = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as DatabaseClient;
  return { database, tx };
}

function sqlText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join("?");
}

describe("PrismaDeviceRepository.create", () => {
  it("returns the created device on success", async () => {
    const { database } = fakeDatabase(() => CREATED_ROW);
    const repository = new PrismaDeviceRepository(database);

    const device = await repository.create(CREATE_INPUT);

    expect(device.deviceId).toBe("device_1");
  });

  it("sets statement, lock and idle-in-transaction timeouts, then checks the insert deadline on the database clock, before inserting", async () => {
    const { database, tx } = fakeDatabase(() => CREATED_ROW);

    await new PrismaDeviceRepository(database).create(CREATE_INPUT);

    const settings = tx.$executeRaw.mock.calls.map((call) => sqlText(call)).join("\n");
    expect(settings).toContain("SET LOCAL statement_timeout");
    expect(settings).toContain("SET LOCAL lock_timeout");
    expect(settings).toContain("SET LOCAL idle_in_transaction_session_timeout");
    const deadlineCall = tx.$queryRaw.mock.calls[0] as unknown[];
    expect(sqlText(deadlineCall)).toContain("clock_timestamp()");
    // The challenge row stays locked until the insert commits, so pruning waits.
    expect(sqlText(deadlineCall)).toContain("FOR SHARE");
    expect(deadlineCall.slice(1)).toEqual(["enrol-challenge-1", "enrol-device", "dpop-jkt-1", 60_000]);
    const lastSetting = Math.max(...tx.$executeRaw.mock.invocationCallOrder);
    const deadlineCheck = tx.$queryRaw.mock.invocationCallOrder[0] as number;
    expect(lastSetting).toBeLessThan(deadlineCheck);
    expect(deadlineCheck).toBeLessThan(tx.device.create.mock.invocationCallOrder[0] as number);
  });

  it("runs the after-deadline-check test hook between the check and the insert", async () => {
    const { database, tx } = fakeDatabase(() => CREATED_ROW);
    const afterDeadlineCheck = vi.fn().mockResolvedValue(undefined);

    await new PrismaDeviceRepository(database, { afterDeadlineCheck }).create(CREATE_INPUT);

    const hookRan = afterDeadlineCheck.mock.invocationCallOrder[0] as number;
    expect(tx.$queryRaw.mock.invocationCallOrder[0] as number).toBeLessThan(hookRan);
    expect(hookRan).toBeLessThan(tx.device.create.mock.invocationCallOrder[0] as number);
  });

  it("registers nothing and throws DeviceChallengeExpiredError when the challenge wasn't consumed within the deadline", async () => {
    const { database, tx } = fakeDatabase(() => CREATED_ROW, { challengeFresh: false });

    await expect(new PrismaDeviceRepository(database).create(CREATE_INPUT)).rejects.toBeInstanceOf(
      DeviceChallengeExpiredError,
    );
    expect(tx.device.create).not.toHaveBeenCalled();
  });

  // This table's two unique constraints (dpop_jkt, and the partial
  // one-active-device-per-account index from the
  // 20260911160000_device_one_active_per_account migration) both exist to
  // close a check-then-insert race EnrolDeviceService's own pre-checks can't
  // close alone -- these tests confirm the P2002 each one produces maps to a
  // clean, typed error instead of surfacing as an unhandled 500.
  it("maps a P2002 on the one-active-device-per-account partial index to DeviceAlreadyEnrolledError (contract 3.6: 409)", async () => {
    const { database } = fakeDatabase(() => {
      throw p2002("devices_one_active_per_account");
    });
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.create(CREATE_INPUT)).rejects.toBeInstanceOf(
      DeviceAlreadyEnrolledError,
    );
  });

  it("maps a P2002 on dpop_jkt to DeviceAlreadyEnrolledError", async () => {
    const { database } = fakeDatabase(() => {
      throw p2002(["dpop_jkt"]);
    });
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.create(CREATE_INPUT)).rejects.toBeInstanceOf(DeviceAlreadyEnrolledError);
  });

  it("re-throws a P2002 on a constraint it doesn't recognize, unmapped", async () => {
    const error = p2002("some_other_constraint");
    const { database } = fakeDatabase(() => {
      throw error;
    });
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.create(CREATE_INPUT)).rejects.toBe(error);
  });

  it("re-throws a non-P2002 error unmapped", async () => {
    const error = new Error("connection reset");
    const { database } = fakeDatabase(() => {
      throw error;
    });
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.create(CREATE_INPUT)).rejects.toBe(error);
  });
});

// Compensation for a failed enrolment (EnrolDeviceService.rollback calls
// into this): deleteMany, not delete, so a call on an id that's already
// gone is a no-op rather than a P2025 throw -- this runs from a catch
// block that's about to rethrow the real error either way.
describe("PrismaDeviceRepository.delete", () => {
  it("deletes the device by id via deleteMany", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const database = { device: { create: vi.fn(), deleteMany } } as unknown as DatabaseClient;
    const repository = new PrismaDeviceRepository(database);

    await repository.delete("device_orphaned");

    expect(deleteMany).toHaveBeenCalledWith({ where: { deviceId: "device_orphaned" } });
  });

  it("does not throw when the device is already gone", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const database = { device: { create: vi.fn(), deleteMany } } as unknown as DatabaseClient;
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.delete("device_does_not_exist")).resolves.toBeUndefined();
  });
});
