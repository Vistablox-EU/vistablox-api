export interface DeviceReplacementCode {
  id: string;
  accountId: string;
  sessionId: string | null;
  codeHash: string;
  expiresAt: Date;
  attemptsUsed: number;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface DeviceReplacementTarget {
  contactEmail: string | null;
  isStaff: boolean;
}

/**
 * Self-service device replacement (AD-271): short-lived, single-use email codes
 * that authorize revoking the active device + device_key login method so a
 * customer can enrol a new device after a reinstall or new phone, without staff
 * and without SMS. Only the code hash is stored; the plaintext is emailed to
 * account.accounts.protected_contact_email and verified against the hash.
 *
 * One repository owns the whole feature — the code lifecycle, the replacement
 * target lookup, the request rate limit and cooldown signals, the device
 * revocation, and the audit trail — mirroring AccountRecoveryRepository.
 */
export interface DeviceReplacementRepository {
  create(input: {
    accountId: string;
    sessionId: string | null;
    codeHash: string;
    expiresAt: Date;
  }): Promise<DeviceReplacementCode>;
  /** The account's not-yet-consumed, not-yet-expired code, or null. */
  findPendingForAccount(accountId: string, now: Date): Promise<DeviceReplacementCode | null>;
  /** The account this code targets (bound email + staff flag), or null if the account is unknown. */
  findReplacementTarget(accountId: string): Promise<DeviceReplacementTarget | null>;
  /** Codes created on or after `since` — drives the per-account request rate limit. */
  countCreatedSince(accountId: string, since: Date): Promise<number>;
  /** The most recent successful-replacement timestamp, or null if none. Drives the cooldown. */
  findLastConsumedAt(accountId: string): Promise<Date | null>;
  /**
   * Record one failed verification attempt on a still-pending code. Returns the
   * updated record, or null if the code was consumed/expired in the meantime.
   */
  incrementAttempts(codeId: string, now: Date): Promise<DeviceReplacementCode | null>;
  /**
   * The single atomic replacement step: consume the code iff its hash matches,
   * it is not already consumed, not expired, and under the attempt cap, then —
   * in the same transaction — revoke the account's active devices and remove
   * their device_key login methods, auditing each step. Returns the revocation
   * summary, or null if the code could not be consumed (already used, expired,
   * wrong hash, or attempt cap hit). Consume and revoke commit together or not
   * at all, so a consumed code always means a completed replacement.
   */
  consumeAndReplace(input: {
    codeId: string;
    codeHash: string;
    now: Date;
    maxAttempts: number;
    accountId: string;
    actorAccountId: string;
    traceId: string;
  }): Promise<{ revokedDeviceIds: string[]; removedLoginMethodCount: number } | null>;
  /**
   * Invalidate any still-pending code for the account so a fresh request starts
   * clean. Idempotent: a retry finds nothing left to do.
   */
  revokePendingForAccount(accountId: string, now: Date): Promise<void>;
  /** Records one step of the replacement flow in the audit log. */
  recordAuditEvent(input: {
    accountId: string;
    actorAccountId: string;
    traceId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    changes: Record<string, string | number | boolean | null>;
    occurredAt: Date;
  }): Promise<void>;
}
