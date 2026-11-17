import type { Logger } from "pino";

import type { JobRunSummary } from "../../../shared/jobs/job-run-summary.js";
import { toSanitizedError } from "../../../shared/logging/log-redaction.js";
import type {
  WalletRegistrationExpiryRepository,
  WalletRegistryWatcherAssessment,
  WalletRegistryWatcherGate,
} from "../repository/wallet.repository.js";

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

export const WALLET_REGISTRATION_EXPIRY_SKIPPED = "wallet_registration_expiry.skipped";

export interface ExpirePendingWalletRegistrationsOptions {
  // A claim pending longer than this is expired (default 24).
  expireAfterHours?: number;
  // The most claims one run expires, oldest first (default 500).
  batchSize?: number;
}

/**
 * Retires wallet claims that stayed pending too long (#177; AD-287, decided
 * 2026-11-17). A pending claim proves nothing and binds nothing, but its
 * commitment stays live for the registry watcher for as long as the row is
 * pending. After expireAfterHours the claim is marked expired: the watcher
 * stops matching its commitment (a late event for it is counted as unmatched
 * and confirms nothing), the customer API reports no wallet, and the account
 * registers again with a new commitment, with fresh authentication when the
 * address differs. Staff can still confirm an expired claim by reconciling it
 * against matching on-chain evidence. The row is kept.
 *
 * It does nothing while the registry watcher is stale, its cursor lags, or it
 * has run before and cannot run now: a claim whose registration event the
 * watcher has not read yet is not abandoned. If the watcher's health cannot be read it does nothing either
 * (fail closed toward not expiring). A skipped run says so once, in one log
 * line, and reports 0 checked and 0 acted; the next run asks again.
 */
export class ExpirePendingWalletRegistrationsService {
  private readonly expireAfterHours: number;
  private readonly batchSize: number;

  public constructor(
    private readonly repository: WalletRegistrationExpiryRepository,
    private readonly watcherGate: WalletRegistryWatcherGate,
    private readonly logger: Pick<Logger, "info" | "warn">,
    private readonly clock: () => Date = () => new Date(),
    options: ExpirePendingWalletRegistrationsOptions = {},
  ) {
    this.expireAfterHours = options.expireAfterHours ?? 24;
    this.batchSize = options.batchSize ?? 500;
  }

  public async execute(traceId: string): Promise<JobRunSummary> {
    const now = this.clock();
    if (!(await this.watcherMayBeTrusted(now, traceId))) return { checked: 0, acted: 0 };

    const cutoff = new Date(now.getTime() - this.expireAfterHours * MILLISECONDS_PER_HOUR);
    const { checked, expired } = await this.repository.expirePendingWalletRegistrations({
      cutoff,
      now,
      batchSize: this.batchSize,
    });
    return { checked, acted: expired };
  }

  private async watcherMayBeTrusted(now: Date, traceId: string): Promise<boolean> {
    let assessment: WalletRegistryWatcherAssessment;
    try {
      assessment = await this.watcherGate.assess(now);
    } catch (error) {
      // Not an error of the run: the next one asks again. Warn, not info,
      // because nothing is supposed to stop the health snapshot being read.
      this.logger.warn(
        {
          event: WALLET_REGISTRATION_EXPIRY_SKIPPED,
          job: "maintenance.wallet_registration_expiry",
          trace_id: traceId,
          reasons: ["health_unreadable"],
          err: toSanitizedError(error),
        },
        "wallet claim expiry skipped: the registry watcher's health could not be read",
      );
      return false;
    }
    if (assessment.mayExpire) return true;
    // The watcher's own alerts say what is wrong with it; this line says only
    // what that did to the sweep.
    this.logger.info(
      {
        event: WALLET_REGISTRATION_EXPIRY_SKIPPED,
        job: "maintenance.wallet_registration_expiry",
        trace_id: traceId,
        reasons: assessment.reasons,
      },
      "wallet claim expiry skipped: the registry watcher cannot be trusted to have read every claim's event",
    );
    return false;
  }
}
