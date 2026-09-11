import { describe, expect, it, vi } from "vitest";

import { IssueDeviceChallengeService } from "../src/modules/auth/application/device-challenge-issuance.service.js";
import type { Device } from "../src/modules/auth/repository/device.repository.js";
import type { DeviceChallengeRepository } from "../src/modules/auth/repository/device-challenge.repository.js";

function challengeRepository(): DeviceChallengeRepository & { issue: ReturnType<typeof vi.fn> } {
  return {
    issue: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn(),
    pruneExpired: vi.fn(),
  };
}

function device(deviceId: string, dpopJkt: string): Device {
  return {
    deviceId,
    accountId: "account-1",
    betterAuthUserId: "user-1",
    dpopJkt,
    bioJkt: "bio",
    biometricPublicJwk: {},
    platform: "android",
    status: "active",
    createdAt: new Date(),
    lastSeenAt: new Date(),
  };
}

describe("IssueDeviceChallengeService.issueLoginChallenge (L1, contract 3.1)", () => {
  it("binds the challenge to the device this DPoP key belongs to when no device_id is sent", async () => {
    const repository = challengeRepository();
    const devices = { findByDpopJkt: vi.fn().mockResolvedValue(device("device_by_key", "jkt-1")) };
    const service = new IssueDeviceChallengeService(repository, () => new Date(), devices);

    await service.issueLoginChallenge({ dpopJkt: "jkt-1", deviceId: undefined, ttlSeconds: 120 });

    expect(devices.findByDpopJkt).toHaveBeenCalledWith("jkt-1");
    expect(repository.issue).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "login", dpopJkt: "jkt-1", deviceId: "device_by_key" }),
    );
  });

  it("uses a sent device_id as given, without a lookup", async () => {
    const repository = challengeRepository();
    const devices = { findByDpopJkt: vi.fn() };
    const service = new IssueDeviceChallengeService(repository, () => new Date(), devices);

    await service.issueLoginChallenge({ dpopJkt: "jkt-1", deviceId: "device_sent", ttlSeconds: 120 });

    expect(devices.findByDpopJkt).not.toHaveBeenCalled();
    expect(repository.issue).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "device_sent" }));
  });

  it("still issues a challenge when the DPoP key belongs to no device, so nothing is revealed", async () => {
    const repository = challengeRepository();
    const service = new IssueDeviceChallengeService(repository, () => new Date(), {
      findByDpopJkt: vi.fn().mockResolvedValue(null),
    });

    const issued = await service.issueLoginChallenge({ dpopJkt: "jkt-nobody", deviceId: undefined, ttlSeconds: 120 });

    expect(typeof issued.challenge).toBe("string");
    expect(repository.issue).toHaveBeenCalledWith(expect.objectContaining({ deviceId: undefined }));
  });
});
