import { describe, expect, it, vi } from "vitest";

import {
  CancelAccountClosureService,
  DecideAccountClosureRequestService,
  ListPendingAccountClosureRequestsService,
  RequestAccountClosureService,
} from "../src/modules/auth/application/account-closure.service.js";
import type {
  AccountClosureRepository,
  AccountClosureRequestRecord,
} from "../src/modules/auth/repository/account-closure.repository.js";
import type { CustomerAccountAdministrator } from "../src/modules/auth/application/customer-account-administrator.js";

const now = new Date("2026-09-05T12:00:00.000Z");

function pendingRequest(overrides: Partial<AccountClosureRequestRecord> = {}): AccountClosureRequestRecord {
  return {
    id: "closure_request_01",
    accountId: "acct_01",
    status: "pending",
    reason: "No longer investing",
    requestedAt: now,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides,
  };
}

function fakeRepository(overrides: Partial<AccountClosureRepository> = {}): AccountClosureRepository {
  return {
    findTarget: vi.fn().mockResolvedValue({
      accountId: "acct_01",
      betterAuthUserId: "auth_01",
      status: "active",
    }),
    findPendingForAccount: vi.fn().mockResolvedValue(null),
    findRequest: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(pendingRequest()),
    cancel: vi.fn().mockResolvedValue(null),
    listPending: vi.fn().mockResolvedValue([]),
    decide: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function fakeAdministrator(overrides: Partial<CustomerAccountAdministrator> = {}): CustomerAccountAdministrator {
  return {
    revokeAllSessions: vi.fn().mockResolvedValue(undefined),
    sendRecoveryCompletionEmail: vi.fn(),
    prepareSelfServicePasskeyReplacement: vi.fn(),
    revokeSessionsForRecoveryCompletion: vi.fn(),
    clearRecoveryRequired: vi.fn(),
    ...overrides,
  };
}

describe("RequestAccountClosureService", () => {
  it("creates a closure request for an active account with no existing pending request", async () => {
    const repository = fakeRepository();

    const result = await new RequestAccountClosureService(repository, () => now).execute({
      accountId: "acct_01",
      reason: "Moving elsewhere",
    });

    expect(repository.create).toHaveBeenCalledWith({
      accountId: "acct_01",
      reason: "Moving elsewhere",
      requestedAt: now,
    });
    expect(result.status).toBe("pending");
  });

  it("rejects a second request while one is already pending", async () => {
    const repository = fakeRepository({
      findPendingForAccount: vi.fn().mockResolvedValue(pendingRequest()),
    });

    await expect(
      new RequestAccountClosureService(repository).execute({ accountId: "acct_01", reason: null }),
    ).rejects.toMatchObject({ code: "account_closure.request_already_pending", status: 409 });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("rejects a request for an account that isn't active", async () => {
    const repository = fakeRepository({
      findTarget: vi.fn().mockResolvedValue({
        accountId: "acct_01",
        betterAuthUserId: "auth_01",
        status: "suspended_restricted",
      }),
    });

    await expect(
      new RequestAccountClosureService(repository).execute({ accountId: "acct_01", reason: null }),
    ).rejects.toMatchObject({ code: "account_closure.target_not_active", status: 409 });
  });
});

describe("CancelAccountClosureService", () => {
  it("cancels the caller's own pending request", async () => {
    const repository = fakeRepository({
      findPendingForAccount: vi.fn().mockResolvedValue(pendingRequest()),
      cancel: vi.fn().mockResolvedValue(pendingRequest({ status: "cancelled" })),
    });

    const result = await new CancelAccountClosureService(repository, () => now).execute("acct_01");

    expect(repository.cancel).toHaveBeenCalledWith({
      requestId: "closure_request_01",
      accountId: "acct_01",
      cancelledAt: now,
    });
    expect(result.status).toBe("cancelled");
  });

  it("throws when there is nothing pending to cancel", async () => {
    const repository = fakeRepository();

    await expect(new CancelAccountClosureService(repository).execute("acct_01")).rejects.toMatchObject({
      code: "account_closure.no_pending_request",
      status: 404,
    });
  });
});

describe("ListPendingAccountClosureRequestsService", () => {
  it("delegates to the repository", async () => {
    const repository = fakeRepository({ listPending: vi.fn().mockResolvedValue([pendingRequest()]) });

    await expect(new ListPendingAccountClosureRequestsService(repository).execute()).resolves.toEqual([
      pendingRequest(),
    ]);
  });
});

describe("DecideAccountClosureRequestService", () => {
  it("revokes sessions before approving, then persists the decision", async () => {
    const repository = fakeRepository({
      findRequest: vi.fn().mockResolvedValue(pendingRequest()),
      decide: vi.fn().mockResolvedValue(pendingRequest({ status: "approved" })),
    });
    const administrator = fakeAdministrator();

    const result = await new DecideAccountClosureRequestService(
      repository,
      administrator,
      () => now,
    ).execute({
      requestId: "closure_request_01",
      reviewerAccountId: "acct_staff",
      decision: "approved",
      note: "Confirmed with customer",
    });

    expect(administrator.revokeAllSessions).toHaveBeenCalledWith("auth_01");
    expect(repository.decide).toHaveBeenCalledWith({
      requestId: "closure_request_01",
      reviewerAccountId: "acct_staff",
      decision: "approved",
      note: "Confirmed with customer",
      decidedAt: now,
    });
    expect(result.status).toBe("approved");
  });

  it("does not revoke sessions when rejecting", async () => {
    const repository = fakeRepository({
      findRequest: vi.fn().mockResolvedValue(pendingRequest()),
      decide: vi.fn().mockResolvedValue(pendingRequest({ status: "rejected" })),
    });
    const administrator = fakeAdministrator();

    await new DecideAccountClosureRequestService(repository, administrator, () => now).execute({
      requestId: "closure_request_01",
      reviewerAccountId: "acct_staff",
      decision: "rejected",
      note: null,
    });

    expect(administrator.revokeAllSessions).not.toHaveBeenCalled();
  });

  it("rejects deciding a request that is not pending", async () => {
    const repository = fakeRepository({ findRequest: vi.fn().mockResolvedValue(null) });
    const administrator = fakeAdministrator();

    await expect(
      new DecideAccountClosureRequestService(repository, administrator).execute({
        requestId: "missing",
        reviewerAccountId: "acct_staff",
        decision: "approved",
        note: null,
      }),
    ).rejects.toMatchObject({ code: "account_closure.request_not_pending", status: 409 });
  });
});
