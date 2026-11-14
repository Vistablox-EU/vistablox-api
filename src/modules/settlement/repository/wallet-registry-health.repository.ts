// The two small ports the wallet-registry alerting needs, kept apart from
// SettlementRepository so that interface (and every fake of it) stays as it is.

export interface WalletRegistryHeartbeat {
  completedAt: Date;
  // The saved cursor after the run; null when the run never saved one.
  cursorBlock: bigint | null;
  // The newest block the run trusted (chain head minus the confirmation depth).
  safeHeadBlock: bigint;
  eventsFound: number;
}

export interface WalletRegistryHeartbeatWriter {
  /**
   * Records that a watcher run completed, overwriting the previous record. One
   * idempotent upsert per run, including a run that found nothing new to scan,
   * so a watcher that is alive but has no new blocks differs from a dead one.
   */
  recordWatcherHeartbeat(input: WalletRegistryHeartbeat): Promise<void>;
}

export interface WalletRegistryHealthReading {
  // Null when no run has completed yet, or the stored value cannot be read.
  heartbeat: WalletRegistryHeartbeat | null;
  pendingTotal: number;
  pendingOverdue: number;
  oldestPendingRequestedAt: Date | null;
  unresolvedMismatches: {
    count: number;
    // The oldest few (at most 20), enough to find them; the count is the total.
    accountIds: string[];
  };
}

export interface WalletRegistryHealthReader {
  /** A read-only view of the registry's health. No RPC: it must work when the RPC is what is down. */
  readWalletRegistryHealth(overdueCutoff: Date): Promise<WalletRegistryHealthReading>;
}
