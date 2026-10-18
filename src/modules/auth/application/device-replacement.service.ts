import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { AppError } from "../../../shared/errors/app-error.js";
import type { EmailSender } from "../../../infrastructure/email/smtp-email-sender.js";
import type { DeviceReplacementRepository } from "../repository/device-replacement.repository.js";

// A six-digit decimal code: 10^6 possibilities, bounded by the attempt cap and
// TTL, so the odds of a blind guess are negligible before invalidation.
const CODE_LENGTH = 6;

export interface DeviceReplacementConfig {
  codeTtlMs: number;
  maxAttempts: number;
  cooldownMs: number;
  requestWindowMs: number;
  maxRequestsPerWindow: number;
}

/**
 * Issues a single-use, short-TTL email code for a signed-in customer, bound to
 * their session, after enforcing the per-account request rate limit and the
 * replacement cooldown. The second factor is email to the bound
 * protected_contact_email — no SMS.
 */
export class RequestDeviceReplacementService {
  public constructor(
    private readonly repository: DeviceReplacementRepository,
    private readonly emailSender: EmailSender,
    private readonly config: DeviceReplacementConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    sessionId: string;
    traceId: string;
  }): Promise<void> {
    const target = await this.repository.findReplacementTarget(input.accountId);
    if (target === null) throw replacementTargetNotFoundError();
    if (target.isStaff) throw replacementTargetIsStaffError();

    // No bound email means the second factor cannot be delivered, so
    // self-service replacement is impossible. Acknowledge without revealing
    // that fact to the caller (the contract never discloses whether an email
    // exists), and do not burn the request rate limit for a no-op.
    if (target.contactEmail === null) {
      await this.repository.recordAuditEvent({
        accountId: input.accountId,
        actorAccountId: input.accountId,
        traceId: input.traceId,
        action: "authentication.device_replacement_unavailable",
        resourceType: "account",
        resourceId: input.accountId,
        changes: { account_id: input.accountId, reason: "no_bound_email" },
        occurredAt: this.clock(),
      });
      return;
    }

    const now = this.clock();

    const lastReplacement = await this.repository.findLastConsumedAt(input.accountId);
    if (lastReplacement !== null && now.getTime() - lastReplacement.getTime() < this.config.cooldownMs) {
      throw replacementCooldownError();
    }

    const recentRequests = await this.repository.countCreatedSince(
      input.accountId,
      new Date(now.getTime() - this.config.requestWindowMs),
    );
    if (recentRequests >= this.config.maxRequestsPerWindow) {
      throw replacementRequestRateLimitedError();
    }

    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(now.getTime() + this.config.codeTtlMs);

    // A fresh code supersedes any still-pending one, so the account never has
    // two live codes and a retry can't accidentally spend an earlier one.
    await this.repository.revokePendingForAccount(input.accountId, now);

    await this.repository.create({
      accountId: input.accountId,
      sessionId: input.sessionId,
      codeHash,
      expiresAt,
    });
    await this.repository.recordAuditEvent({
      accountId: input.accountId,
      actorAccountId: input.accountId,
      traceId: input.traceId,
      action: "authentication.device_replacement_requested",
      resourceType: "account",
      resourceId: input.accountId,
      changes: { account_id: input.accountId, expires_at: expiresAt.toISOString() },
      occurredAt: now,
    });

    // Best-effort delivery: the code is already persisted, so a transient SMTP
    // failure must not surface an error the customer can't act on — they simply
    // never receive the code and request again within the rate limit.
    try {
      await this.emailSender.sendDeviceReplacementCodeEmail({
        to: target.contactEmail,
        code,
        expiresInMinutes: Math.round(this.config.codeTtlMs / 60_000),
      });
    } catch {
      // Ignored: issuance is durable; the delivery failure is not the customer's
      // error to fix. A subsequent request (within rate limits) re-sends.
    }

    return;
  }
}

/**
 * Verifies the email code and, on success, atomically consumes it and revokes
 * the account's active device + device_key login method (in one transaction,
 * see DeviceReplacementRepository.consumeAndReplace). The customer then
 * re-enrols normally (E1). A code is single-use and bound to the session that
 * requested it.
 */
export class VerifyDeviceReplacementService {
  public constructor(
    private readonly repository: DeviceReplacementRepository,
    private readonly config: Pick<DeviceReplacementConfig, "maxAttempts">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    sessionId: string;
    code: string;
    traceId: string;
  }): Promise<void> {
    const target = await this.repository.findReplacementTarget(input.accountId);
    if (target === null) throw replacementTargetNotFoundError();
    if (target.isStaff) throw replacementTargetIsStaffError();

    const now = this.clock();
    const pending = await this.repository.findPendingForAccount(input.accountId, now);
    if (pending === null) throw replacementCodeInvalidError();

    // Bind to the requesting session: a code issued to one session cannot be
    // spent from another. null means the code predates session binding — still
    // accepted, since it was only ever issued to an authenticated account.
    if (pending.sessionId !== null && pending.sessionId !== input.sessionId) {
      throw replacementCodeInvalidError();
    }

    const submittedHash = hashCode(input.code);
    if (!safeCodeEquals(submittedHash, pending.codeHash)) {
      await this.repository.incrementAttempts(pending.id, now);
      throw replacementCodeInvalidError();
    }

    const replaced = await this.repository.consumeAndReplace({
      codeId: pending.id,
      codeHash: pending.codeHash,
      now,
      maxAttempts: this.config.maxAttempts,
      accountId: input.accountId,
      actorAccountId: input.accountId,
      traceId: input.traceId,
    });
    if (replaced === null) throw replacementCodeInvalidError();
  }
}

/** A fresh six-digit decimal code. Only its hash is ever stored. */
export function generateCode(): string {
  return randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");
}

/** The stored form of a code — never the plaintext. */
export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Constant-time comparison so the hash check does not leak timing. */
function safeCodeEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, "utf8");
  const bBuffer = Buffer.from(b, "utf8");
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function replacementTargetNotFoundError(): AppError {
  return new AppError({
    code: "authentication.device_replacement_target_not_found",
    title: "Account not found",
    status: 404,
    detail: "No account matches the given account_id.",
  });
}

function replacementTargetIsStaffError(): AppError {
  return new AppError({
    code: "authentication.device_replacement_target_is_staff",
    title: "Not a customer account",
    status: 409,
    detail: "This account has an active staff role. Use the staff recovery flow instead.",
  });
}

function replacementCooldownError(): AppError {
  return new AppError({
    code: "authentication.device_replacement_cooldown",
    title: "Device replacement recently completed",
    status: 409,
    detail: "A device was replaced too recently. Try again after the cooldown period.",
  });
}

function replacementRequestRateLimitedError(): AppError {
  return new AppError({
    code: "authentication.device_replacement_request_rate_limited",
    title: "Too many replacement requests",
    status: 429,
    detail: "Too many device replacement codes have been requested. Try again later.",
  });
}

function replacementCodeInvalidError(): AppError {
  return new AppError({
    code: "authentication.device_replacement_code_invalid",
    title: "Invalid or expired code",
    status: 400,
    detail: "The device replacement code is invalid, expired, or already used.",
  });
}
