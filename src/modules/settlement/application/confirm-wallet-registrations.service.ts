import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";
import type { SettlementRepository } from "../repository/settlement.repository.js";

// Bounds each run's eth_getLogs range so a long gap since the last run (a
// deploy, a worker outage) can't exceed an RPC provider's block-range cap in
// one call. At Base's ~2s block time this is a couple hours of blocks --
// comfortably ahead of real-time on the hourly schedule this job runs on
// (worker.ts), and an outage longer than that just takes a few extra runs to
// fully catch up rather than failing outright.
const MAX_BLOCK_RANGE_PER_RUN = 2000n;

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
  ) {}

  public async execute(): Promise<ConfirmWalletRegistrationsSummary> {
    const latestBlock = await this.chain.publicClient.getBlockNumber();
    const cursor = await this.repository.getLastProcessedWalletRegistryBlock();
    // No cursor yet: start watching from now rather than genesis. There is
    // no pre-existing wallet registration to recover (this contract has no
    // history before this deploy), and scanning from block 0 would blow
    // past most RPC providers' eth_getLogs range cap on the very first run.
    const fromBlock = cursor === null ? latestBlock : cursor + 1n;

    const summary: ConfirmWalletRegistrationsSummary = {
      fromBlock: fromBlock.toString(),
      toBlock: latestBlock.toString(),
      eventsFound: 0,
      registrationsConfirmed: 0,
      unmatchedEvents: 0,
      addressMismatches: [],
    };

    if (fromBlock > latestBlock) {
      return summary;
    }

    const toBlock =
      latestBlock - fromBlock > MAX_BLOCK_RANGE_PER_RUN ? fromBlock + MAX_BLOCK_RANGE_PER_RUN : latestBlock;
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
