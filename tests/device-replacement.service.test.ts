import { describe, expect, it, vi } from "vitest";

import {
  generateCode,
  hashCode,
  RequestDeviceReplacementService,
  VerifyDeviceReplacementService,
  type DeviceReplacementConfig,
} from "../src/modules/auth/application/device-replacement.service.js";
import type { EmailSender } from "../src/infrastructure/email/smtp-email-sender.js";
import type {
  DeviceReplacementCode,
  DeviceReplacementRepository,
  DeviceReplacementTarget,
} from "../src/modules/auth/repository/device-replacement.repository.js";

const HOUR = 60 * 60 * 1000;

function config(overrides: Partial<DeviceReplacementConfig> = {}): DeviceReplacementConfig {
  return {
    codeTtlMs: 10 * 60 * 1000,
    maxAttempts: 5,
    cooldownMs: 72 * HOUR,
    requestWindowMs: HOUR,
    maxRequestsPerWindow: 3,
    ...overrides,
  };
}

function code(overrides: Partial<DeviceReplacementCode> = {}): DeviceReplacementCode {
  return {
    id: "drc_1",
    accountId: "acct_1",
    sessionId: "sess_1",
    codeHash: hashCode("123456"),
    expiresAt: new Date("2026-09-21T12:00:00.000Z"),
    attemptsUsed: 0,
    consumedAt: null,
    createdAt: new Date("2026-09-21T11:50:00.000Z"),
    ...overrides,
  };
}

function target(overrides: Partial<DeviceReplacementTarget> = {}): DeviceReplacementTarget {
  return { contactEmail: "investor@example.test", isStaff: false, ...overrides };
}

interface FakeRepository extends DeviceReplacementRepository {
  created: Array<{ accountId: string; sessionId: string | null; codeHash: string; expiresAt: Date }>;
  audited: Array<{ action: string; changes: Record<string, string | number | boolean | null> }>;
}

function repository(overrides: Partial<DeviceReplacementRepository> = {}): FakeRepository {
  const pendingCode = code();
  const base: FakeRepository = {
    create: vi.fn().mockResolvedValue(pendingCode),
    findPendingForAccount: vi.fn().mockResolvedValue(pendingCode),
    findReplacementTarget: vi.fn().mockResolvedValue(target()),
    countCreatedSince: vi.fn().mockResolvedValue(0),
    findLastConsumedAt: vi.fn().mockResolvedValue(null),
    incrementAttempts: vi.fn().mockResolvedValue(pendingCode),
    consumeAndReplace: vi.fn().mockResolvedValue({ revokedDeviceIds: ["device_old"], removedLoginMethodCount: 1 }),
    revokePendingForAccount: vi.fn().mockResolvedValue(undefined),
    recordAuditEvent: vi.fn().mockResolvedValue(undefined),
    created: [],
    audited: [],
    ...overrides,
  };
  base.create = vi.fn(async (input) => {
    base.created.push(input);
    return pendingCode;
  });
  base.recordAuditEvent = vi.fn(async (input) => {
    base.audited.push({ action: input.action, changes: input.changes });
  });
  return base;
}

function emailSender(): EmailSender & { sent: Array<{ to: string; code: string; expiresInMinutes: number }> } {
  const sent: Array<{ to: string; code: string; expiresInMinutes: number }> = [];
  return {
    sendDeviceReplacementCodeEmail: vi.fn(async (email) => {
      sent.push(email);
    }),
    sendStaffInvitationEmail: vi.fn(),
    sendApplicantResponseReminderEmail: vi.fn(),
    sendKycRenewalReminderEmail: vi.fn(),
    sendReconfirmationReminderEmail: vi.fn(),
    sendReconfirmationWindowOpenedEmail: vi.fn(),
    sendAccountRecoveryCaseOpenedEmail: vi.fn(),
    sendAccountRecoveryApprovedEmail: vi.fn(),
    sendAccountRecoveryRejectedEmail: vi.fn(),
    sendAccountRecoveryCompletedEmail: vi.fn(),
    sendPasskeyRecoveryEmail: vi.fn(),
    sent,
  };
}

describe("RequestDeviceReplacementService", () => {
  it("creates a hashed code, supersedes pending, sends the code, and audits the request", async () => {
    const repo = repository();
    const sender = emailSender();
    const service = new RequestDeviceReplacementService(repo, sender, config());

    await service.execute({ accountId: "acct_1", sessionId: "sess_1", traceId: "trace_1" });

    expect(repo.created).toHaveLength(1);
    expect(repo.created[0]?.codeHash).not.toContain("123456"); // never the plaintext
    expect(repo.revokePendingForAccount).toHaveBeenCalledWith("acct_1", expect.any(Date));
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe("investor@example.test");
    expect(sender.sent[0]?.code).toMatch(/^\d{6}$/);
    expect(repo.audited.some((a) => a.action === "authentication.device_replacement_requested")).toBe(true);
  });

  it("acknowledges without a code when there is no bound email (no enumeration)", async () => {
    const repo = repository({ findReplacementTarget: vi.fn().mockResolvedValue(target({ contactEmail: null })) });
    const service = new RequestDeviceReplacementService(repo, emailSender(), config());

    await service.execute({ accountId: "acct_1", sessionId: "sess_1", traceId: "t" });

    expect(repo.created).toHaveLength(0);
    expect(repo.audited.some((a) => a.action === "authentication.device_replacement_unavailable")).toBe(true);
  });

  it("rejects staff accounts", async () => {
    const repo = repository({ findReplacementTarget: vi.fn().mockResolvedValue(target({ isStaff: true })) });
    const service = new RequestDeviceReplacementService(repo, emailSender(), config());

    await expect(service.execute({ accountId: "acct_1", sessionId: "sess_1", traceId: "t" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("enforces the replacement cooldown", async () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    const repo = repository({
      findLastConsumedAt: vi.fn().mockResolvedValue(new Date(now.getTime() - 1 * HOUR)),
    });
    const service = new RequestDeviceReplacementService(repo, emailSender(), config(), () => now);

    await expect(service.execute({ accountId: "acct_1", sessionId: "sess_1", traceId: "t" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("enforces the per-account request rate limit", async () => {
    const repo = repository({ countCreatedSince: vi.fn().mockResolvedValue(3) });
    const service = new RequestDeviceReplacementService(repo, emailSender(), config());

    await expect(service.execute({ accountId: "acct_1", sessionId: "sess_1", traceId: "t" })).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("VerifyDeviceReplacementService", () => {
  it("consumes and replaces when the code matches", async () => {
    const repo = repository();
    const service = new VerifyDeviceReplacementService(repo, config());

    await service.execute({ accountId: "acct_1", sessionId: "sess_1", code: "123456", traceId: "trace_1" });

    expect(repo.consumeAndReplace).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct_1", codeHash: hashCode("123456") }),
    );
  });

  it("records a failed attempt on a wrong code and does not replace", async () => {
    const repo = repository();
    const service = new VerifyDeviceReplacementService(repo, config());

    await expect(
      service.execute({ accountId: "acct_1", sessionId: "sess_1", code: "000000", traceId: "t" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(repo.incrementAttempts).toHaveBeenCalled();
    expect(repo.consumeAndReplace).not.toHaveBeenCalled();
  });

  it("rejects when no pending code exists (expired or never requested)", async () => {
    const repo = repository({ findPendingForAccount: vi.fn().mockResolvedValue(null) });
    const service = new VerifyDeviceReplacementService(repo, config());

    await expect(service.execute({ accountId: "acct_1", sessionId: "sess_1", code: "123456", traceId: "t" })).rejects.toMatchObject({
      status: 400,
    });
    expect(repo.consumeAndReplace).not.toHaveBeenCalled();
  });

  it("rejects when the code was requested from a different session", async () => {
    const repo = repository({
      findPendingForAccount: vi.fn().mockResolvedValue(code({ sessionId: "other_session" })),
    });
    const service = new VerifyDeviceReplacementService(repo, config());

    await expect(service.execute({ accountId: "acct_1", sessionId: "sess_1", code: "123456", traceId: "t" })).rejects.toMatchObject({
      status: 400,
    });
    expect(repo.consumeAndReplace).not.toHaveBeenCalled();
  });

  it("fails when consumeAndReplace reports the code was already spent", async () => {
    const repo = repository({ consumeAndReplace: vi.fn().mockResolvedValue(null) });
    const service = new VerifyDeviceReplacementService(repo, config());

    await expect(service.execute({ accountId: "acct_1", sessionId: "sess_1", code: "123456", traceId: "t" })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("generateCode", () => {
  it("returns a six-digit zero-padded string", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
  });
});
