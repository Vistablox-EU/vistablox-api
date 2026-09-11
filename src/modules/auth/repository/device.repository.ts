export interface Device {
  deviceId: string;
  accountId: string;
  betterAuthUserId: string;
  dpopJkt: string;
  bioJkt: string;
  biometricPublicJwk: Record<string, unknown>;
  platform: string;
  status: string;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface DeviceRepository {
  /** Generates and assigns the deviceId itself -- the caller never picks one. */
  create(input: {
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
  }): Promise<Device>;
  findByDeviceId(deviceId: string): Promise<Device | null>;
  findByDpopJkt(dpopJkt: string): Promise<Device | null>;
  /** Drives the `pending_approval` check (E2) -- the only active device on an account, if any. */
  findActiveDeviceForAccount(accountId: string): Promise<Device | null>;
  touchLastSeen(deviceId: string, at: Date): Promise<void>;
}
