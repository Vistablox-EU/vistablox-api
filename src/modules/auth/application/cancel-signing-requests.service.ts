import type { DeviceRepository } from "../repository/device.repository.js";
import type { SigningRequestRepository } from "../repository/signing-request.repository.js";

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

  public async execute(dpopJkt: string): Promise<number> {
    const device = await this.devices.findByDpopJkt(dpopJkt);
    if (device === null) return 0;
    return this.requests.cancelPendingAndSignedForDevice(device.deviceId);
  }
}