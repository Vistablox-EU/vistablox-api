export class DeviceChallengeExpiredError extends Error {
  public readonly code = "DEVICE_CHALLENGE_EXPIRED" as const;
  public constructor() {
    super("This challenge has expired, was already used, or doesn't exist.");
    this.name = "DeviceChallengeExpiredError";
  }
}

/**
 * Contract 3.6: DEVICE_ALREADY_ENROLLED (409). Two distinct triggers share
 * this one code/status, both meaning "you can't enrol right now because
 * there's already an active device in the way": this exact DPoP key is
 * already an active device (findByDpopJkt, or a raced P2002 on its unique
 * constraint), or the account already has a different active device
 * (findActiveDeviceForAccount, or a raced P2002 on the one-active-device-
 * per-account partial index) -- approving a *second* device needs the
 * P1-P5 pairing endpoints, which this PR doesn't build (see the plan's
 * "explicitly out of scope" section). The contract doesn't have a separate
 * code for "pairing isn't built yet," and a client can't act differently
 * on the two triggers anyway (both say "go to device login" or "use your
 * other device"), so they aren't distinguished here.
 */
export class DeviceAlreadyEnrolledError extends Error {
  public readonly code = "DEVICE_ALREADY_ENROLLED" as const;
  public constructor() {
    super("This account or DPoP key is already an active device.");
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
