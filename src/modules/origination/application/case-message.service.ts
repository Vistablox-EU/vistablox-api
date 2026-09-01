import { AppError } from "../../../shared/errors/app-error.js";
import type { CaseMessageRecord, OriginationRepository, ThreadLane } from "../repository/origination.repository.js";

// PERMISSION_MATRIX.md's two "Post in ... thread" rows, mirrored here:
// the applicant lane is reachable from both the owner-facing router (always
// this lane, hardcoded — the applicant has no other lane to reach) and the
// operations-facing one; the internal_case lane only from operations. Each
// side does its own ownership/existence check before reaching the shared
// repository methods below, matching how every other origination write
// already separates that check from the write itself.

export class ListOwnCaseMessagesService {
  public constructor(private readonly repository: OriginationRepository) {}

  public async execute(accountId: string, caseId: string) {
    const originationCase = await this.repository.getOwnedCase(accountId, caseId);
    if (originationCase === null) throw caseNotFoundError();
    const messages = await this.repository.listCaseMessages(caseId, "applicant");
    return { data: messages.map(toCaseMessageResponse) };
  }
}

export class PostOwnCaseMessageService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: { accountId: string; caseId: string; body: string }) {
    const originationCase = await this.repository.getOwnedCase(input.accountId, input.caseId);
    if (originationCase === null) throw caseNotFoundError();
    const message = await this.repository.postCaseMessage({
      caseId: input.caseId,
      lane: "applicant",
      authorAccountId: input.accountId,
      body: input.body,
      postedAt: this.clock(),
    });
    if (message === null) throw caseNotFoundError();
    return { data: toCaseMessageResponse(message) };
  }
}

export class ListCaseMessagesForOperationsService {
  public constructor(private readonly repository: OriginationRepository) {}

  public async execute(caseId: string, lane: ThreadLane) {
    const originationCase = await this.repository.getCaseForOperations(caseId);
    if (originationCase === null) throw caseNotFoundError();
    const messages = await this.repository.listCaseMessages(caseId, lane);
    return { data: messages.map(toCaseMessageResponse) };
  }
}

export class PostCaseMessageForOperationsService {
  public constructor(
    private readonly repository: OriginationRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(input: {
    accountId: string;
    caseId: string;
    lane: ThreadLane;
    body: string;
  }) {
    const originationCase = await this.repository.getCaseForOperations(input.caseId);
    if (originationCase === null) throw caseNotFoundError();
    const message = await this.repository.postCaseMessage({
      caseId: input.caseId,
      lane: input.lane,
      authorAccountId: input.accountId,
      body: input.body,
      postedAt: this.clock(),
    });
    if (message === null) throw caseNotFoundError();
    return { data: toCaseMessageResponse(message) };
  }
}

function toCaseMessageResponse(message: CaseMessageRecord) {
  return {
    message_id: message.messageId,
    author_account_id: message.authorAccountId,
    body: message.body,
    created_at: message.createdAt.toISOString(),
  };
}

function caseNotFoundError(): AppError {
  return new AppError({
    code: "origination.case_not_found",
    title: "Origination case not found",
    status: 404,
    detail: "The requested origination case was not found.",
  });
}
