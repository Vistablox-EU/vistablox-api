export class DeviceChallengeExpiredError extends Error {
  public readonly code = "DEVICE_CHALLENGE_EXPIRED" as const;
  public constructor() {
    super("This challenge has expired, was already used, or doesn't exist.");
    this.name = "DeviceChallengeExpiredError";
  }
}

export class DeviceAlreadyEnrolledError extends Error {
  public readonly code = "DEVICE_ALREADY_ENROLLED" as const;
  public constructor() {
    super("This DPoP key is already an active device.");
    this.name = "DeviceAlreadyEnrolledError";
  }
}

export class DeviceUnsupportedError extends Error {
  public readonly code = "DEVICE_UNSUPPORTED" as const;
  public constructor() {
    super("This device can't produce a Play Integrity verdict and isn't supported.");
    this.name = "DeviceUnsupportedError";
  }
}

export class DeviceLoginFailedError extends Error {
  public readonly code = "DEVICE_LOGIN_FAILED" as const;
  public constructor() {
    // Deliberately undifferentiated message (contract 3.6): unknown
    // device, bad signature, and kid mismatch must all read the same,
    // to avoid account/device enumeration.
    super("Device login failed.");
    this.name = "DeviceLoginFailedError";
  }
}

/**
 * Contract-flagged scope gap, not a wire-contract error code: this account
 * already has an active device, and approving a second one needs the P1-P5
 * pairing endpoints, which this PR doesn't build (see the plan's "explicitly
 * out of scope" section). Mapped to 501 at the plugin boundary, not one of
 * the contract's own codes.
 */
export class DevicePairingNotImplementedError extends Error {
  public readonly code = "device.pairing_not_implemented" as const;
  public constructor() {
    super(
      "This account already has an active device. Pairing a second device isn't built yet.",
    );
    this.name = "DevicePairingNotImplementedError";
  }
}
