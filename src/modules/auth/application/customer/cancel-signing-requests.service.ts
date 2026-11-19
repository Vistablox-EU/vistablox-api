import type { DeviceRepository } from "../../repository/customer/device.repository.js";
import type { SigningRequestRepository } from "../../repository/customer/signing-request.repository.js";

/**
 * D3 (device removal): cancels a device's pending/signed signing requests
 * when the device is revoked. The plan makes revocation and recovery-start
 * cancel a device's `pending`/`signed` requests, so a removed phone can't
 * keep a request alive that it could have continued to sign.
 */
export class CancelPendingSigningRequestsForDeviceService {
  public constructor(
    private readonly devices: Pick<DeviceRepository, "findByDpopJkt">,
    private readonly requests: Pick<SigningRequestRepository, "cancelPendingAndSignedForDevice">,
  ) {}

  // Scoped to the caller: a key that is not the caller's own active device
  // cancels nothing, exactly as an unknown key does, so the route can't be
  // used to cancel or probe another account's requests.
  public async execute(accountId: string, dpopJkt: string): Promise<number> {
    const device = await this.devices.findByDpopJkt(dpopJkt);
    if (device === null || device.accountId !== accountId) return 0;
    return this.requests.cancelPendingAndSignedForDevice(accountId, device.deviceId);
  }
}