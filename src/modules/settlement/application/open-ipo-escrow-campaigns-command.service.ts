import type { Logger } from "pino";

import { toEurcMicros } from "../../../shared/domain/currency.js";
import type { IpoEscrowCampaignAction, IpoEscrowCampaignDifference } from "../domain/ipo-escrow-campaign.policy.js";
import type { OfferingForIpoEscrowActivation, SettlementRepository } from "../repository/settlement.repository.js";
import {
  describeIpoEscrowCampaignDifferences,
  type IpoEscrowCampaignActivation,
  type IpoEscrowCampaignRequest,
  type OpenIpoEscrowCampaignService,
} from "./open-ipo-escrow-campaign.service.js";

export const IPO_ESCROW_ACTIVATION_ALERT_EVENTS = {
  failed: "settlement.ipo_escrow_campaign_open_failed",
} as const;

export type IpoEscrowActivationMode = "dry_run" | "confirm";

/**
 * What happened (confirm) or would happen (dry run) to one offering's campaign.
 *  - would_open / opened: the chain shows no campaign; it is (to be) opened.
 *  - would_record / recorded: it is already open with the offering's parameters;
 *    the observation is (to be) recorded or refreshed.
 *  - refused_mismatch: it is open with other parameters. Not adopted. Needs an operator.
 *  - resolved_on_chain: it is Successful or Failed although the offering still
 *    takes reservations. It cannot be reopened. Needs an operator.
 *  - failed: the attempt threw (an RPC error, a reverted transaction).
 */
export type IpoEscrowActivationStatus =
  | "would_open"
  | "would_record"
  | "opened"
  | "recorded"
  | "refused_mismatch"
  | "resolved_on_chain"
  | "failed";

export interface IpoEscrowActivationOutcome {
  pivId: string;
  tokenId: string;
  status: IpoEscrowActivationStatus;
  /** opened: the openCampaign transaction. */
  transactionHash?: string;
  /** recorded / would_record: nothing was recorded for this offering before. */
  adopted?: boolean;
  /** refused_mismatch. */
  differences?: IpoEscrowCampaignDifference[];
  /** resolved_on_chain. */
  chainState?: "successful" | "failed";
  /** resolved_on_chain: the stored observation now says so (confirm), or would (dry run). */
  observationUpdated?: boolean;
  /** failed. */
  error?: string;
}

const NEEDS_ATTENTION: ReadonlySet<IpoEscrowActivationStatus> = new Set([
  "refused_mismatch",
  "resolved_on_chain",
  "failed",
]);

export interface IpoEscrowActivationReport {
  mode: IpoEscrowActivationMode;
  offeringsChecked: number;
  outcomes: IpoEscrowActivationOutcome[];
  /** 0 when every offering is fine; 1 when any failed or needs manual action. */
  exitCode: 0 | 1;
}

/**
 * The operator command that opens IPO escrow campaigns (AD-286, decided
 * 2026-11-17). It replaces the hourly sweep of the original proposal: opening a
 * campaign is a chain write with the platform's own key, so a person runs it.
 *
 * Dry run (the default) reads the chain and the database and writes nothing.
 * With confirm it opens, one offering at a time, the campaign of each offering
 * that is still open for reservations and has an IPO deadline ahead, and
 * records the observation the reservation gate reads. An error on one offering
 * is reported and does not stop the next. A campaign that is already open with
 * the offering's own parameters is recorded (the run is idempotent); one open
 * with other parameters is refused, and one already resolved is reported:
 * both need an operator, and make the exit code non-zero.
 *
 * The caller has checked the prerequisites (a testnet, a configured bundle,
 * see ipoEscrowActivationRefusal) before building the chain clients.
 */
export class OpenIpoEscrowCampaignsCommandService {
  public constructor(
    private readonly repository: Pick<SettlementRepository, "findOfferingsForIpoEscrowActivation">,
    private readonly campaigns: Pick<OpenIpoEscrowCampaignService, "inspect" | "activate">,
    private readonly logger: Pick<Logger, "error">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async run(mode: IpoEscrowActivationMode): Promise<IpoEscrowActivationReport> {
    const offerings = await this.repository.findOfferingsForIpoEscrowActivation(this.clock());
    const outcomes: IpoEscrowActivationOutcome[] = [];

    // One at a time: each open waits for its receipt, and the operator
    // account's nonce is shared with the finalizer (the operator-key lock
    // serializes the sends, the order of the receipts is not otherwise needed).
    for (const offering of offerings) {
      outcomes.push(await this.runOne(mode, offering));
    }

    return {
      mode,
      offeringsChecked: offerings.length,
      outcomes,
      exitCode: outcomes.some((outcome) => NEEDS_ATTENTION.has(outcome.status)) ? 1 : 0,
    };
  }

  private async runOne(
    mode: IpoEscrowActivationMode,
    offering: OfferingForIpoEscrowActivation,
  ): Promise<IpoEscrowActivationOutcome> {
    const base = { pivId: offering.pivId, tokenId: offering.tokenId };
    try {
      const request = this.requestFor(offering);
      if (mode === "dry_run") {
        const inspection = await this.campaigns.inspect(request);
        return { ...base, ...describePlan(inspection.action) };
      }
      return { ...base, ...describeActivation(await this.campaigns.activate(request)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          event: IPO_ESCROW_ACTIVATION_ALERT_EVENTS.failed,
          severity: "error",
          err: error,
          piv_id: offering.pivId,
          token_id: offering.tokenId,
        },
        "opening an IPO escrow campaign failed",
      );
      return { ...base, status: "failed", error: message };
    }
  }

  private requestFor(offering: OfferingForIpoEscrowActivation): IpoEscrowCampaignRequest {
    return {
      pivId: offering.pivId,
      tokenId: BigInt(offering.tokenId),
      // The same target (the offering's target raise, EURC base units) and
      // deadline (the case's ipo_end_at, unix seconds) the handoff job uses.
      targetAmount: toEurcMicros(offering.targetRaiseEur),
      deadline: BigInt(Math.floor(offering.ipoEndAt.getTime() / 1000)),
    };
  }
}

function describePlan(action: IpoEscrowCampaignAction): Omit<IpoEscrowActivationOutcome, "pivId" | "tokenId"> {
  switch (action.kind) {
    case "open":
      return { status: "would_open" };
    case "record_open":
      return { status: "would_record", adopted: action.adopted };
    case "refuse_mismatch":
      return { status: "refused_mismatch", differences: action.differences };
    case "resolved":
      return { status: "resolved_on_chain", chainState: action.state, observationUpdated: action.hasRow };
  }
}

function describeActivation(
  activation: IpoEscrowCampaignActivation,
): Omit<IpoEscrowActivationOutcome, "pivId" | "tokenId"> {
  switch (activation.kind) {
    case "opened":
      return { status: "opened", transactionHash: activation.transactionHash };
    case "recorded_open":
      return { status: "recorded", adopted: activation.adopted };
    case "refused_mismatch":
      return { status: "refused_mismatch", differences: activation.differences };
    case "resolved":
      return { status: "resolved_on_chain", chainState: activation.state, observationUpdated: activation.recorded };
  }
}

export interface IpoEscrowActivationHeader {
  chainNetwork: string;
  escrowContractAddress: string;
  treasuryAddress: string;
}

/**
 * The lines the command prints. The header says which treasury every campaign
 * gets: the single placeholder PIV_TREASURY_ADDRESS, since the per-PIV treasury
 * (C-008 question 3, AD-278's addendum) is not decided.
 */
export function renderIpoEscrowActivationReport(
  header: IpoEscrowActivationHeader,
  report: IpoEscrowActivationReport,
): string[] {
  const lines: string[] = [];
  lines.push(
    report.mode === "confirm"
      ? "Opening IPO escrow campaigns (confirmed run):"
      : "Dry run, nothing changed. IPO escrow campaigns it would open or record:",
  );
  lines.push(`  chain:     ${header.chainNetwork} (testnet only until the AD-234 activation gate passes)`);
  lines.push(`  escrow:    ${header.escrowContractAddress}`);
  lines.push(
    `  treasury:  ${header.treasuryAddress}, the single PIV_TREASURY_ADDRESS placeholder for every campaign. ` +
      "The per-PIV treasury (C-008 question 3, AD-278 addendum) is not decided.",
  );
  lines.push(`  offerings: ${report.offeringsChecked} open for reservations with an IPO deadline ahead`);
  lines.push("");

  for (const outcome of report.outcomes) {
    lines.push(`  piv_id ${outcome.pivId} (token_id ${outcome.tokenId}): ${describeOutcome(outcome, report.mode)}`);
  }
  if (report.outcomes.length === 0) lines.push("  (none)");

  const attention = report.outcomes.filter((outcome) => NEEDS_ATTENTION.has(outcome.status)).length;
  lines.push("");
  if (attention > 0) {
    lines.push(`${attention} offering(s) failed or need manual action (marked above). Exit code 1.`);
  }
  if (report.mode === "dry_run") {
    lines.push("Re-run with --confirm to open them.");
  }
  return lines;
}

function describeOutcome(outcome: IpoEscrowActivationOutcome, mode: IpoEscrowActivationMode): string {
  switch (outcome.status) {
    case "would_open":
      return "would open the campaign (no campaign on-chain)";
    case "would_record":
      return outcome.adopted === true
        ? "would record the campaign already open on-chain with this offering's parameters"
        : "would refresh the observation of the open campaign";
    case "opened":
      return `opened (tx ${outcome.transactionHash ?? "unknown"})`;
    case "recorded":
      return outcome.adopted === true
        ? "already open on-chain with this offering's parameters; recorded"
        : "open on-chain; observation refreshed";
    case "refused_mismatch":
      return (
        `NEEDS MANUAL ACTION: open on-chain with other parameters, not adopted (` +
        `${describeIpoEscrowCampaignDifferences(outcome.differences ?? [])})`
      );
    case "resolved_on_chain":
      return (
        `NEEDS MANUAL ACTION: ${outcome.chainState ?? "resolved"} on-chain, it takes no contributions; ` +
        (outcome.observationUpdated === true
          ? mode === "confirm"
            ? "the stored observation now says so"
            : "the stored observation would be updated"
          : "there is no stored observation to update")
      );
    case "failed":
      return `FAILED: ${outcome.error ?? "unknown error"}`;
  }
}
