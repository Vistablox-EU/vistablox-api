import { describe, expect, it, vi } from "vitest";

import { CancelPendingSigningRequestsForDeviceService } from "../src/modules/auth/application/cancel-signing-requests.service.js";
import { PrepareSigningRequestService } from "../src/modules/auth/application/prepare-signing-request.service.js";
import type { Device } from "../src/modules/auth/repository/device.repository.js";
import type { CreateSigningRequestInput, SigningRequest } from "../src/modules/auth/repository/signing-request.repository.js";

const DEVICE: Device = {
  deviceId: "dev_1",
  accountId: "acc_1",
  betterAuthUserId: "user_1",
  dpopJkt: "dpop-jkt-1",
  bioJkt: "bio-jkt-1",
  biometricPublicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  platform: "android",
  status: "active",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
};

function createdRow(input: CreateSigningRequestInput): SigningRequest {
  return {
    id: "req_created",
    accountId: input.accountId,
    deviceId: input.deviceId,
    requestType: input.requestType,
    amountMinor: input.amountMinor,
    currency: input.currency,
    destination: input.destination,
    createdBy: input.createdBy,
    status: "pending",
    signedJws: null,
    signedAt: null,
    createdAt: input.now ?? new Date("2026-09-01T10:00:00.000Z"),
    expiresAt: input.expiresAt,
  };
}

function createInput(overrides: Partial<CreateSigningRequestInput> = {}): CreateSigningRequestInput {
  // Fixed dates safely ahead of the runner's clock; the service's only time
  // gate is "expiresAt must not already have passed".
  const now = new Date(Date.now() + 60_000);
  return {
    accountId: "acc_1",
    deviceId: "dev_1",
    requestType: "reservation_reconfirm",
    amountMinor: "125000",
    currency: "EUR",
    destination: { kind: "iban", value: "DE89370400440532013000" },
    createdBy: { kind: "user", label: "Damir" },
    expiresAt: new Date(Date.now() + 5 * 60_000),
    now,
    ...overrides,
  };
}

describe("PrepareSigningRequestService", () => {
  it("creates a pending request with the server's own view of the action", async () => {
    const create = vi.fn().mockImplementation(async (input: CreateSigningRequestInput) => createdRow(input));
    const service = new PrepareSigningRequestService({ create } as never);

    const result = await service.execute(createInput());

    expect(result.status).toBe("pending");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_1",
        deviceId: "dev_1",
        requestType: "reservation_reconfirm",
        amountMinor: "125000",
      }),
    );
  });

  it("refuses an expiry in the past with a 422 (never a server-stored past-due request)", async () => {
    const create = vi.fn();
    const service = new PrepareSigningRequestService({ create } as never);

    await expect(
      service.execute(
        createInput({ expiresAt: new Date(Date.now() - 1) }),
      ),
    ).rejects.toMatchObject({
      code: "signing_request.invalid_expiry",
      status: 422,
    });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("CancelPendingSigningRequestsForDeviceService", () => {
  it("cancels the device's pending/signed requests when the DPoP key resolves to one", async () => {
    const cancel = vi.fn().mockResolvedValue(3);
    const service = new CancelPendingSigningRequestsForDeviceService(
      { findByDpopJkt: vi.fn().mockResolvedValue(DEVICE) } as never,
      { cancelPendingAndSignedForDevice: cancel } as never,
    );

    await expect(service.execute("dpop-jkt-1")).resolves.toBe(3);
    expect(cancel).toHaveBeenCalledWith("dev_1");
  });

  it("cancels nothing when the DPoP key no longer resolves to an active device", async () => {
    const cancel = vi.fn();
    const service = new CancelPendingSigningRequestsForDeviceService(
      { findByDpopJkt: vi.fn().mockResolvedValue(null) } as never,
      { cancelPendingAndSignedForDevice: cancel } as never,
    );

    await expect(service.execute("dpop-jkt-1")).resolves.toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
});