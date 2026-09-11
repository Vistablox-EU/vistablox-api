import { ulid } from "ulid";

import type { DatabaseClient } from "../../../infrastructure/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { Device, DeviceRepository } from "./device.repository.js";

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
