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
  /**
   * Compensation for a failed enrolment: create() and the internalAdapter
   * session-creation call that follows it use different DB clients (Prisma
   * vs better-auth's own pg Pool), so there's no single transaction to roll
   * back if session creation fails after the device row is already
   * written. Deleting it here is what EnrolDeviceService.rollback calls
   * into -- without it, a failed enrolment leaves an orphaned active
   * device that blocks every retry via the one-active-device-per-account
   * constraint (confirmed live on staging before this existed). Safe to
   * call on an id that's already gone (a no-op, not an error).
   */
  delete(deviceId: string): Promise<void>;
}
