import { describe, expect, it, vi } from "vitest";

import { Prisma } from "../src/generated/prisma/client.js";
import { DeviceAlreadyEnrolledError } from "../src/modules/auth/application/device-auth-errors.js";
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
};

function p2002(constraintOrTarget: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${constraintOrTarget}\``,
    { code: "P2002", clientVersion: "test", meta: { target: constraintOrTarget } },
  );
}

function fakeDatabase(createImpl: () => unknown): DatabaseClient {
  return {
    device: { create: vi.fn(createImpl) },
  } as unknown as DatabaseClient;
}

// This table's two unique constraints (dpop_jkt, and the partial
// one-active-device-per-account index from the
// 20260911160000_device_one_active_per_account migration) both exist to
// close a check-then-insert race EnrolDeviceService's own pre-checks can't
// close alone -- these tests confirm the P2002 each one produces maps to a
// clean, typed error instead of surfacing as an unhandled 500.
describe("PrismaDeviceRepository.create", () => {
  it("returns the created device on success", async () => {
    const database = fakeDatabase(() => ({
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
    }));
    const repository = new PrismaDeviceRepository(database);

    const device = await repository.create(CREATE_INPUT);

    expect(device.deviceId).toBe("device_1");
  });

  it("maps a P2002 on the one-active-device-per-account partial index to DeviceAlreadyEnrolledError (contract 3.6: 409)", async () => {
    const database = fakeDatabase(() => {
      throw p2002("devices_one_active_per_account");
    });
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.create(CREATE_INPUT)).rejects.toBeInstanceOf(
      DeviceAlreadyEnrolledError,
    );
  });

  it("maps a P2002 on dpop_jkt to DeviceAlreadyEnrolledError", async () => {
    const database = fakeDatabase(() => {
      throw p2002(["dpop_jkt"]);
    });
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.create(CREATE_INPUT)).rejects.toBeInstanceOf(DeviceAlreadyEnrolledError);
  });

  it("re-throws a P2002 on a constraint it doesn't recognize, unmapped", async () => {
    const error = p2002("some_other_constraint");
    const database = fakeDatabase(() => {
      throw error;
    });
    const repository = new PrismaDeviceRepository(database);

    await expect(repository.create(CREATE_INPUT)).rejects.toBe(error);
  });

  it("re-throws a non-P2002 error unmapped", async () => {
    const error = new Error("connection reset");
    const database = fakeDatabase(() => {
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
