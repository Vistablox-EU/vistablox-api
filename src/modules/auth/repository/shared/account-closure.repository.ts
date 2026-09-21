export type AccountClosureRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface AccountClosureRequestRecord {
  id: string;
  accountId: string;
  status: AccountClosureRequestStatus;
  reason: string | null;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

export interface ClosureTarget {
  accountId: string;
  betterAuthUserId: string;
  status: string;
}

export interface PendingClosureRequestSnapshot {
  reason: string | null;
  requestedAt: Date;
}

// Read-only boundary port for modules outside auth (profile, so far) that
// need to show whether an account has a closure request in flight, without
// depending on AccountClosureRepository's write surface. Same rationale as
// WalletStatusReader in wallet/repository/wallet.repository.js.
export interface PendingClosureRequestReader {
  getPending(accountId: string): Promise<PendingClosureRequestSnapshot | null>;
}

/**
 * Customer-initiated, staff-reviewed account closure (see AD note in
 * schema.prisma near AccountClosureRequest). Single reviewer, unlike
 * AccountRecoveryRepository's dual-review case model -- there is no
 * takeover-fraud risk to guard against here, only an already-authenticated
 * customer's own request to leave.
 */
export interface AccountClosureRepository {
  findTarget(accountId: string): Promise<ClosureTarget | null>;
  findPendingForAccount(accountId: string): Promise<AccountClosureRequestRecord | null>;
  findRequest(requestId: string): Promise<AccountClosureRequestRecord | null>;
  create(input: {
    accountId: string;
    reason: string | null;
    requestedAt: Date;
  }): Promise<AccountClosureRequestRecord>;
  cancel(input: {
    requestId: string;
    accountId: string;
    cancelledAt: Date;
  }): Promise<AccountClosureRequestRecord | null>;
  listPending(): Promise<AccountClosureRequestRecord[]>;
  decide(input: {
    requestId: string;
    reviewerAccountId: string;
    decision: "approved" | "rejected";
    note: string | null;
    decidedAt: Date;
  }): Promise<AccountClosureRequestRecord | null>;
}
