import type { ConfirmWalletRegistrationsService } from "./confirm-wallet-registrations.service.js";
import type { WalletRegistryAlertReporter } from "./wallet-registry-alert-reporter.js";

/** The one thing the runner needs from the settlement repository. */
export interface WalletRegistryCursorReader {
  getLastProcessedWalletRegistryBlock(): Promise<bigint | null>;
}

/**
 * One scheduled run of the wallet-registry watcher, with its reporting.
 *
 * ConfirmWalletRegistrationsService does the work and returns a summary; this
 * reads the cursor it left behind (the ground truth, rather than something
 * derived from the summary) and hands both to the reporter, which logs, counts
 * and writes the heartbeat. A failed run is reported and rethrown as a copy
 * with its URLs stripped, so the RPC URL never reaches pg-boss's stored job
 * output or the dead-letter line.
 */
export class RunWalletRegistryWatcherService {
  public constructor(
    private readonly confirm: Pick<ConfirmWalletRegistrationsService, "execute">,
    private readonly cursor: WalletRegistryCursorReader,
    private readonly reporter: Pick<WalletRegistryAlertReporter, "runStarted" | "reportRun" | "reportFailure">,
    private readonly newTraceId: () => string,
  ) {}

  public async execute(): Promise<void> {
    const traceId = this.newTraceId();
    this.reporter.runStarted();

    let summary: Awaited<ReturnType<ConfirmWalletRegistrationsService["execute"]>>;
    let cursorBlock: bigint | null;
    try {
      summary = await this.confirm.execute();
      cursorBlock = await this.cursor.getLastProcessedWalletRegistryBlock();
    } catch (error) {
      throw this.reporter.reportFailure(error, traceId);
    }

    await this.reporter.reportRun(summary, cursorBlock, traceId);
  }
}
