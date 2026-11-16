import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import type { WalletRegistrationExpiryRepository } from "../repository/wallet.repository.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/**
 * Retires wallet claims that stayed pending too long (#177). A pending claim
 * proves nothing and binds nothing, but its commitment stays live for the
 * registry watcher for as long as the row is pending. After
 * expireAfterHours the claim is marked expired: the watcher stops matching
 * its commitment, the customer API reports no wallet, and the account
 * registers again with a new commitment. The registry contract accepts any
 * number of register() calls, so a device that signs late loses nothing but
 * the retry.
 */
export class ExpirePendingWalletRegistrationsService {
  public constructor(
    private readonly repository: WalletRegistrationExpiryRepository,
    private readonly clock: () => Date = () => new Date(),
    private readonly expireAfterHours = 24,
  ) {}

  public async execute(_traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - this.expireAfterHours * MILLISECONDS_PER_HOUR);
    const { checked, expired } = await this.repository.expirePendingWalletRegistrations({ cutoff, now });
    return { checked, acted: expired };
  }
}
