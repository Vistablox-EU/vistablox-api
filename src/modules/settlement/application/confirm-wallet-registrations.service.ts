import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";
import type { SettlementRepository } from "../repository/settlement.repository.js";

// Bounds each run's eth_getLogs range so a long gap since the last run (a
// deploy, a worker outage) can't exceed an RPC provider's block-range cap in
// one call. At Base's ~2s block time this is a couple hours of blocks --
// comfortably ahead of real-time on the hourly schedule this job runs on
// (worker.ts), and an outage longer than that just takes a few extra runs to
// fully catch up rather than failing outright.
const MAX_BLOCK_RANGE_PER_RUN = 2000n;

// Re-read a small tail of the previous range on every run. RPC providers can
// briefly return incomplete logs while a block is being indexed, and a
// worker restart between reading logs and persisting the cursor must not turn
// that transient gap into a permanently pending wallet.
export const WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS = 32n;

// Never finalize a registration from a block that may still be re-organized.
// Base has a short confirmation time; three blocks is deliberately modest
// while still keeping the mobile UX responsive.
export const WALLET_REGISTRY_CONFIRMATION_DEPTH = 3n;
export const WALLET_REGISTRY_PENDING_WARN_AFTER_MS = 5 * 60 * 1000;

interface WalletRegisteredEventArgs {
  wallet?: string;
  commitment?: string;
}

export interface ConfirmWalletRegistrationsSummary {
  fromBlock: string;
  toBlock: string;
  eventsFound: number;
  registrationsConfirmed: number;
  unmatchedEvents: number;
  addressMismatches: string[];
  pendingRegistrationsOverdue: number;
  pendingWarnAfterMinutes: number;
}

/**
 * AD-241 step 9-10's confirmation half: watches VistaBloxWalletRegistry's
 * WalletRegistered event, matches each one back to the pending
 * wallet_registrations row that requested it (by registration_commitment --
 * the one-time opaque value RegisterWalletService handed the mobile app),
 * sanity-checks the on-chain sender against the stored address, and marks
 * registered_at. Idempotent by construction (AD-241's invariant): a
 * commitment only matches a row where registered_at IS NULL, so replaying
 * the same event twice (an overlapping rescan after a crash between the read
 * and the cursor write) is a harmless no-op the second time, not a double
 * write.
 */
export class ConfirmWalletRegistrationsService {
  public constructor(
    private readonly repository: SettlementRepository,
    private readonly chain: ChainClients,
    private readonly clock: () => Date = () => new Date(),
    private readonly pendingWarnAfterMs = WALLET_REGISTRY_PENDING_WARN_AFTER_MS,
  ) {}

  public async execute(): Promise<ConfirmWalletRegistrationsSummary> {
    const latestBlock = await this.chain.publicClient.getBlockNumber();
    const cursor = await this.repository.getLastProcessedWalletRegistryBlock();
    const now = this.clock();
    const pendingRegistrationsOverdue = await this.repository.countPendingWalletRegistrationsBefore(
      new Date(now.getTime() - this.pendingWarnAfterMs),
    );
    const safeLatestBlock = latestBlock - WALLET_REGISTRY_CONFIRMATION_DEPTH;
    // No cursor yet: start at the latest *safe* block rather than the head.
    // Subsequent runs overlap the cursor tail so an indexed-log race or
    // crash cannot strand a registration forever.
    const fromBlock =
      cursor === null
        ? safeLatestBlock
        : cursor > WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS
          ? cursor - WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS + 1n
          : 0n;

    const summary: ConfirmWalletRegistrationsSummary = {
      fromBlock: fromBlock.toString(),
      toBlock: safeLatestBlock.toString(),
      eventsFound: 0,
      registrationsConfirmed: 0,
      unmatchedEvents: 0,
      addressMismatches: [],
      pendingRegistrationsOverdue,
      pendingWarnAfterMinutes: Math.round(this.pendingWarnAfterMs / 60_000),
    };

    if (safeLatestBlock < 0n || fromBlock > safeLatestBlock) {
      return summary;
    }

    const toBlock =
      safeLatestBlock - fromBlock > MAX_BLOCK_RANGE_PER_RUN
        ? fromBlock + MAX_BLOCK_RANGE_PER_RUN
        : safeLatestBlock;
    summary.toBlock = toBlock.toString();

    const events = (await this.chain.walletRegistry.getEvents.WalletRegistered!({
      fromBlock,
      toBlock,
    })) as unknown as ReadonlyArray<{ args: WalletRegisteredEventArgs }>;
    summary.eventsFound = events.length;

    for (const event of events) {
      const { wallet, commitment } = event.args;
      if (wallet === undefined || commitment === undefined) {
        continue; // Defensive only -- the ABI guarantees both are present.
      }

      const pending = await this.repository.findPendingWalletRegistrationByCommitment(commitment);
      if (pending === null) {
        summary.unmatchedEvents += 1;
        continue;
      }

      if (pending.walletAddress.toLowerCase() !== wallet.toLowerCase()) {
        summary.addressMismatches.push(
          `account_id=${pending.accountId} commitment=${commitment}: stored wallet ${pending.walletAddress} != on-chain sender ${wallet}`,
        );
        // Durable record, not just the log line worker.ts emits from this
        // summary -- a log scrolls away; this is what a support/security
        // review actually queries later.
        await this.repository.recordWalletRegistrationAddressMismatch({
          accountId: pending.accountId,
          commitment,
          storedWalletAddress: pending.walletAddress,
          onChainSender: wallet,
          detectedAt: this.clock(),
        });
        continue;
      }

      await this.repository.confirmWalletRegistration(pending.accountId, this.clock());
      summary.registrationsConfirmed += 1;
    }

    await this.repository.setLastProcessedWalletRegistryBlock(toBlock);

    return summary;
  }
}
