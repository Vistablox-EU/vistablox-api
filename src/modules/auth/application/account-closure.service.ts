import { AppError } from "../../../shared/errors/app-error.js";
import type {
  AccountClosureRepository,
  AccountClosureRequestRecord,
} from "../repository/account-closure.repository.js";
import type { CustomerAccountAdministrator } from "./customer-account-administrator.js";

export class RequestAccountClosureService {
  public constructor(
    private readonly repository: AccountClosureRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    reason: string | null;
  }): Promise<AccountClosureRequestRecord> {
    const target = await this.repository.findTarget(input.accountId);
    if (target === null) throw targetNotFoundError();
    if (target.status !== "active") throw targetNotActiveError();

    const existing = await this.repository.findPendingForAccount(input.accountId);
    if (existing !== null) throw requestAlreadyPendingError();

    return this.repository.create({
      accountId: input.accountId,
      reason: input.reason,
      requestedAt: this.clock(),
    });
  }
}

export class CancelAccountClosureService {
  public constructor(
    private readonly repository: AccountClosureRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(accountId: string): Promise<AccountClosureRequestRecord> {
    const pending = await this.repository.findPendingForAccount(accountId);
    if (pending === null) throw noPendingRequestError();

    const cancelled = await this.repository.cancel({
      requestId: pending.id,
      accountId,
      cancelledAt: this.clock(),
    });
    if (cancelled === null) throw noPendingRequestError();
    return cancelled;
  }
}

export class ListPendingAccountClosureRequestsService {
  public constructor(private readonly repository: AccountClosureRepository) {}

  public async execute(): Promise<AccountClosureRequestRecord[]> {
    return this.repository.listPending();
  }
}

export class DecideAccountClosureRequestService {
  public constructor(
    private readonly repository: AccountClosureRepository,
    private readonly administrator: CustomerAccountAdministrator,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    requestId: string;
    reviewerAccountId: string;
    decision: "approved" | "rejected";
    note: string | null;
  }): Promise<AccountClosureRequestRecord> {
    const request = await this.repository.findRequest(input.requestId);
    if (request === null || request.status !== "pending") throw requestNotPendingError();

    if (input.decision === "approved") {
      const target = await this.repository.findTarget(request.accountId);
      if (target === null) throw targetNotFoundError();
      // Kill live access first, then persist the decision -- closes the
      // window during which a still-valid session could act before the
      // closure is durable (mirrors OpenAccountRecoveryCaseService).
      await this.administrator.revokeAllSessions(target.betterAuthUserId);
    }

    const decidedAt = this.clock();
    const decided = await this.repository.decide({
      requestId: input.requestId,
      reviewerAccountId: input.reviewerAccountId,
      decision: input.decision,
      note: input.note,
      decidedAt,
    });
    if (decided === null) throw requestNotPendingError();
    return decided;
  }
}

function targetNotFoundError(): AppError {
  return new AppError({
    code: "account_closure.target_not_found",
    title: "Account not found",
    status: 404,
    detail: "No account was found for this closure request.",
  });
}

function targetNotActiveError(): AppError {
  return new AppError({
    code: "account_closure.target_not_active",
    title: "Account not active",
    status: 409,
    detail: "Only an active account can request closure.",
  });
}

function requestAlreadyPendingError(): AppError {
  return new AppError({
    code: "account_closure.request_already_pending",
    title: "Closure request already pending",
    status: 409,
    detail: "This account already has a closure request awaiting review.",
  });
}

function noPendingRequestError(): AppError {
  return new AppError({
    code: "account_closure.no_pending_request",
    title: "No pending closure request",
    status: 404,
    detail: "This account has no closure request awaiting review.",
  });
}

function requestNotPendingError(): AppError {
  return new AppError({
    code: "account_closure.request_not_pending",
    title: "Closure request not pending",
    status: 409,
    detail: "This closure request has already been resolved or does not exist.",
  });
}
