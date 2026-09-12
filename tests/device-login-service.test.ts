import { webcrypto } from "node:crypto";

import { SignJWT, calculateJwkThumbprint, exportJWK, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import { DeviceChallengeExpiredError, DeviceLoginFailedError } from "../src/modules/auth/application/device-auth-errors.js";
import { LoginDeviceService } from "../src/modules/auth/application/device-login.service.js";
import { CHALLENGE_REPLAY_WINDOW_MS } from "../src/modules/auth/domain/device-challenge-replay.js";
import type { Device, DeviceRepository } from "../src/modules/auth/repository/device.repository.js";
import type { DeviceChallengeRepository } from "../src/modules/auth/repository/device-challenge.repository.js";

const JWS_TYP = "vistablox-device-auth+jwt";

class FakeDeviceRepository implements DeviceRepository {
  public devices: Device[] = [];
  public touchedAt: Date | undefined;

  public async create(): Promise<Device> {
    throw new Error("not used by LoginDeviceService");
  }

  public async findByDeviceId(deviceId: string): Promise<Device | null> {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null;
  }

  public async findByDpopJkt(dpopJkt: string): Promise<Device | null> {
    return this.devices.find((d) => d.dpopJkt === dpopJkt) ?? null;
  }

  public async findActiveDeviceForAccount(): Promise<Device | null> {
    return null;
  }

  public async touchLastSeen(deviceId: string, at: Date): Promise<void> {
    const device = this.devices.find((d) => d.deviceId === deviceId);
    if (device !== undefined) device.lastSeenAt = at;
    this.touchedAt = at;
  }

  public async delete(deviceId: string): Promise<void> {
    this.devices = this.devices.filter((d) => d.deviceId !== deviceId);
  }
}

interface FakeChallengeEntry {
  purpose: string;
  dpopJkt: string;
  deviceId: string | undefined;
  expiresAt: Date;
  consumed: boolean;
  consumedAt?: Date;
}

class FakeChallengeRepository implements DeviceChallengeRepository {
  public issued = new Map<string, FakeChallengeEntry>();
  public consumeCallCount = 0;

  /** `clock` stands in for the database's clock: consumption time and the replay window. */
  public constructor(private readonly clock: () => Date = () => new Date()) {}

  public async issue(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
    expiresAt: Date;
  }): Promise<void> {
    this.issued.set(input.challenge, {
      purpose: input.purpose,
      dpopJkt: input.dpopJkt,
      deviceId: input.deviceId,
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }

  public async consume(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
  }): Promise<boolean> {
    this.consumeCallCount++;
    const entry = this.issued.get(input.challenge);
    if (
      entry === undefined ||
      entry.purpose !== input.purpose ||
      entry.dpopJkt !== input.dpopJkt ||
      entry.deviceId !== input.deviceId ||
      entry.consumed ||
      entry.expiresAt <= this.clock()
    ) {
      return false;
    }
    entry.consumed = true;
    entry.consumedAt = this.clock();
    return true;
  }

  public async wasConsumedWithinReplayWindow(input: {
    challenge: string;
    purpose: string;
    dpopJkt: string;
    deviceId: string | undefined;
  }): Promise<boolean> {
    const entry = this.issued.get(input.challenge);
    return (
      entry !== undefined &&
      entry.purpose === input.purpose &&
      entry.dpopJkt === input.dpopJkt &&
      entry.deviceId === input.deviceId &&
      entry.consumedAt !== undefined &&
      entry.consumedAt.getTime() >= this.clock().getTime() - CHALLENGE_REPLAY_WINDOW_MS
    );
  }

  public async pruneExpired(): Promise<number> {
    return 0;
  }
}

async function makeDeviceKeyPair(): Promise<{
  privateKey: webcrypto.CryptoKey;
  publicJwk: JWK;
  bioJkt: string;
}> {
  const { privateKey, publicKey } = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await exportJWK(publicKey);
  const bioJkt = await calculateJwkThumbprint(publicJwk, "sha256");
  return { privateKey, publicJwk, bioJkt };
}

async function buildLoginJws(options: {
  privateKey: webcrypto.CryptoKey;
  bioJkt: string;
  challenge: string;
  deviceId: string;
  purpose?: string;
  iat?: number;
}): Promise<string> {
  return new SignJWT({
    purpose: options.purpose ?? "login",
    challenge: options.challenge,
    device_id: options.deviceId,
    iat: options.iat ?? Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({ alg: "ES256", typ: JWS_TYP, kid: options.bioJkt })
    .sign(options.privateKey);
}

function makeDevice(overrides: Partial<Device> & { deviceId: string; dpopJkt: string; biometricPublicJwk: Record<string, unknown> }): Device {
  return {
    deviceId: overrides.deviceId,
    accountId: overrides.accountId ?? "account-1",
    betterAuthUserId: overrides.betterAuthUserId ?? "user-1",
    dpopJkt: overrides.dpopJkt,
    bioJkt: overrides.bioJkt ?? "bio-jkt",
    biometricPublicJwk: overrides.biometricPublicJwk,
    platform: overrides.platform ?? "android",
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? new Date(),
    lastSeenAt: overrides.lastSeenAt ?? new Date(),
  };
}

describe("LoginDeviceService", () => {
  it("logs in an enrolled, active device: consumes the challenge, verifies the JWS, touches lastSeen", async () => {
    const { privateKey, publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    const challenge = "login-challenge-1";
    await challenges.issue({
      challenge,
      purpose: "login",
      dpopJkt: "dpop-jkt-1",
      deviceId: "device_1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const jws = await buildLoginJws({ privateKey, bioJkt, challenge, deviceId: "device_1" });

    const service = new LoginDeviceService(challenges, devices);
    const result = await service.execute({
      deviceId: "device_1",
      dpopJkt: "dpop-jkt-1",
      challenge,
      jws,
    });

    expect(result.deviceId).toBe("device_1");
    expect(challenges.consumeCallCount).toBe(1);
    expect(devices.touchedAt).toBeDefined();
  });

  it("rejects an unknown device id", async () => {
    const devices = new FakeDeviceRepository();
    const challenges = new FakeChallengeRepository();
    const service = new LoginDeviceService(challenges, devices);

    await expect(
      service.execute({
        deviceId: "device_missing",
        dpopJkt: "dpop-jkt-x",
        challenge: "irrelevant",
        jws: "irrelevant",
      }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
    expect(challenges.consumeCallCount).toBe(0);
  });

  it("finds the device from the DPoP key when no device_id is sent, and accepts a JWS without the device_id claim", async () => {
    const { privateKey, publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_by_key", dpopJkt: "dpop-jkt-by-key", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    await challenges.issue({
      challenge: "login-by-key",
      purpose: "login",
      dpopJkt: "dpop-jkt-by-key",
      deviceId: "device_by_key",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const jws = await new SignJWT({ purpose: "login", challenge: "login-by-key", iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "ES256", typ: JWS_TYP, kid: bioJkt })
      .sign(privateKey);
    const service = new LoginDeviceService(challenges, devices);

    const result = await service.execute({ deviceId: undefined, dpopJkt: "dpop-jkt-by-key", challenge: "login-by-key", jws });

    expect(result.deviceId).toBe("device_by_key");
  });

  it("rejects a sent device_id that isn't the device the DPoP key belongs to, before consuming the challenge", async () => {
    const own = await makeDeviceKeyPair();
    const other = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_own", dpopJkt: "dpop-jkt-own", bioJkt: own.bioJkt, biometricPublicJwk: own.publicJwk as Record<string, unknown> }),
      makeDevice({ deviceId: "device_other", dpopJkt: "dpop-jkt-other", bioJkt: other.bioJkt, biometricPublicJwk: other.publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    const service = new LoginDeviceService(challenges, devices);

    await expect(
      service.execute({ deviceId: "device_other", dpopJkt: "dpop-jkt-own", challenge: "irrelevant", jws: "irrelevant" }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
    expect(challenges.consumeCallCount).toBe(0);
  });

  it("rejects a DPoP key that belongs to no device, with no device_id sent", async () => {
    const challenges = new FakeChallengeRepository();
    const service = new LoginDeviceService(challenges, new FakeDeviceRepository());

    await expect(
      service.execute({ deviceId: undefined, dpopJkt: "dpop-jkt-nobody", challenge: "irrelevant", jws: "irrelevant" }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
    expect(challenges.consumeCallCount).toBe(0);
  });

  it("refuses login for an iOS device while the platform policy is Android-only, before consuming the challenge", async () => {
    const { publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({
        deviceId: "device_ios",
        dpopJkt: "dpop-jkt-ios",
        bioJkt,
        biometricPublicJwk: publicJwk as Record<string, unknown>,
        platform: "ios",
      }),
    );
    const challenges = new FakeChallengeRepository();
    const service = new LoginDeviceService(challenges, devices);

    await expect(
      service.execute({ deviceId: "device_ios", dpopJkt: "dpop-jkt-ios", challenge: "irrelevant", jws: "irrelevant" }),
    ).rejects.toMatchObject({ code: "MOBILE_PLATFORM_NOT_SUPPORTED" });
    expect(challenges.consumeCallCount).toBe(0);
  });

  it("accepts an iOS device once the injected policy includes iOS", async () => {
    const { privateKey, publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({
        deviceId: "device_ios_ok",
        dpopJkt: "dpop-jkt-ios-ok",
        bioJkt,
        biometricPublicJwk: publicJwk as Record<string, unknown>,
        platform: "ios",
      }),
    );
    const challenges = new FakeChallengeRepository();
    await challenges.issue({
      challenge: "login-challenge-ios",
      purpose: "login",
      dpopJkt: "dpop-jkt-ios-ok",
      deviceId: "device_ios_ok",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const jws = await buildLoginJws({ privateKey, bioJkt, challenge: "login-challenge-ios", deviceId: "device_ios_ok" });
    const service = new LoginDeviceService(challenges, devices, () => new Date(), {
      supportedPlatforms: ["android", "ios"],
    });

    const result = await service.execute({
      deviceId: "device_ios_ok",
      dpopJkt: "dpop-jkt-ios-ok",
      challenge: "login-challenge-ios",
      jws,
    });

    expect(result.deviceId).toBe("device_ios_ok");
  });

  it("answers DEVICE_CHALLENGE_REPLAYED for a challenge used moments ago, and DEVICE_CHALLENGE_EXPIRED once the window has passed", async () => {
    let now = Date.now();
    const clock = () => new Date(now);
    const { publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_replay", dpopJkt: "dpop-jkt-replay", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository(clock);
    await challenges.issue({
      challenge: "login-replay",
      purpose: "login",
      dpopJkt: "dpop-jkt-replay",
      deviceId: "device_replay",
      expiresAt: new Date(now + 120_000),
    });
    await challenges.consume({
      challenge: "login-replay",
      purpose: "login",
      dpopJkt: "dpop-jkt-replay",
      deviceId: "device_replay",    });
    const service = new LoginDeviceService(challenges, devices, clock);
    const replay = { deviceId: "device_replay", dpopJkt: "dpop-jkt-replay", challenge: "login-replay", jws: "irrelevant" };

    now += 120_000;
    await expect(service.execute(replay)).rejects.toMatchObject({ code: "DEVICE_CHALLENGE_REPLAYED" });

    now += 1;
    await expect(service.execute(replay)).rejects.toMatchObject({ code: "DEVICE_CHALLENGE_EXPIRED" });
  });

  it("answers DEVICE_CHALLENGE_REPLAYED to a replay that sent no device_id: the check uses the key's device, not the body", async () => {
    const now = Date.now();
    const { publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_nobody_sent", dpopJkt: "dpop-jkt-nobody-sent", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    // L1 bound the challenge to the key's device (contract 3.1).
    await challenges.issue({
      challenge: "login-replay-no-id",
      purpose: "login",
      dpopJkt: "dpop-jkt-nobody-sent",
      deviceId: "device_nobody_sent",
      expiresAt: new Date(now + 120_000),
    });
    await challenges.consume({
      challenge: "login-replay-no-id",
      purpose: "login",
      dpopJkt: "dpop-jkt-nobody-sent",
      deviceId: "device_nobody_sent",    });
    const service = new LoginDeviceService(challenges, devices, () => new Date(now + 1_000));

    await expect(
      service.execute({ deviceId: undefined, dpopJkt: "dpop-jkt-nobody-sent", challenge: "login-replay-no-id", jws: "irrelevant" }),
    ).rejects.toMatchObject({ code: "DEVICE_CHALLENGE_REPLAYED" });
  });

  it("rejects a revoked (non-active) device", async () => {
    const { publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({
        deviceId: "device_1",
        dpopJkt: "dpop-jkt-1",
        bioJkt,
        biometricPublicJwk: publicJwk as Record<string, unknown>,
        status: "revoked",
      }),
    );
    const challenges = new FakeChallengeRepository();
    const service = new LoginDeviceService(challenges, devices);

    await expect(
      service.execute({
        deviceId: "device_1",
        dpopJkt: "dpop-jkt-1",
        challenge: "irrelevant",
        jws: "irrelevant",
      }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
    expect(challenges.consumeCallCount).toBe(0);
  });

  it("rejects a login attempt presenting the wrong DPoP key for this device", async () => {
    const { publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({
        deviceId: "device_1",
        dpopJkt: "the-real-dpop-jkt",
        bioJkt,
        biometricPublicJwk: publicJwk as Record<string, unknown>,
      }),
    );
    const challenges = new FakeChallengeRepository();
    const service = new LoginDeviceService(challenges, devices);

    await expect(
      service.execute({
        deviceId: "device_1",
        dpopJkt: "a-different-dpop-jkt",
        challenge: "irrelevant",
        jws: "irrelevant",
      }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
    expect(challenges.consumeCallCount).toBe(0);
  });

  it("rejects an expired/unknown/already-consumed challenge", async () => {
    const { publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    const service = new LoginDeviceService(challenges, devices);

    await expect(
      service.execute({
        deviceId: "device_1",
        dpopJkt: "dpop-jkt-1",
        challenge: "never-issued",
        jws: "irrelevant",
      }),
    ).rejects.toBeInstanceOf(DeviceChallengeExpiredError);
  });

  it("rejects a JWS signed by the wrong key (challenge is still consumed)", async () => {
    const { publicJwk, bioJkt } = await makeDeviceKeyPair();
    const impostor = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    const challenge = "login-challenge-2";
    await challenges.issue({
      challenge,
      purpose: "login",
      dpopJkt: "dpop-jkt-1",
      deviceId: "device_1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Signed by a different key than the one on file for device_1 -- kid
    // still claims to be the stored bioJkt, but the signature won't verify
    // against the stored public jwk.
    const jws = await buildLoginJws({
      privateKey: impostor.privateKey,
      bioJkt,
      challenge,
      deviceId: "device_1",
    });

    const service = new LoginDeviceService(challenges, devices);
    await expect(
      service.execute({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", challenge, jws }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
    expect(challenges.consumeCallCount).toBe(1);
  });

  it("rejects a JWS bound to a different device_id", async () => {
    const { privateKey, publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    const challenge = "login-challenge-3";
    await challenges.issue({
      challenge,
      purpose: "login",
      dpopJkt: "dpop-jkt-1",
      deviceId: "device_1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const jws = await buildLoginJws({ privateKey, bioJkt, challenge, deviceId: "device_other" });

    const service = new LoginDeviceService(challenges, devices);
    await expect(
      service.execute({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", challenge, jws }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
  });

  it("rejects a JWS with the wrong purpose claim", async () => {
    const { privateKey, publicJwk, bioJkt } = await makeDeviceKeyPair();
    const devices = new FakeDeviceRepository();
    devices.devices.push(
      makeDevice({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", bioJkt, biometricPublicJwk: publicJwk as Record<string, unknown> }),
    );
    const challenges = new FakeChallengeRepository();
    const challenge = "login-challenge-4";
    await challenges.issue({
      challenge,
      purpose: "login",
      dpopJkt: "dpop-jkt-1",
      deviceId: "device_1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const jws = await buildLoginJws({
      privateKey,
      bioJkt,
      challenge,
      deviceId: "device_1",
      purpose: "enrol-device",
    });

    const service = new LoginDeviceService(challenges, devices);
    await expect(
      service.execute({ deviceId: "device_1", dpopJkt: "dpop-jkt-1", challenge, jws }),
    ).rejects.toBeInstanceOf(DeviceLoginFailedError);
  });
});
