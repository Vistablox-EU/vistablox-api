import type { Logger } from "pino";

import { toEurcMicros } from "../../../shared/domain/currency.js";
import type { SettlementRepository } from "../repository/settlement.repository.js";
import type { OpenIpoEscrowCampaignService } from "./open-ipo-escrow-campaign.service.js";

export interface OpenPendingIpoEscrowCampaignsSummary {
  offeringsChecked: number;
  campaignsReady: number;
  // Found already resolved (Successful or Failed) on-chain, so not recorded
  // as ready.
  campaignsNotReady: number;
  errors: string[];
}

/**
 * The escrow activation step (#176). Offerings opened while settlement was
 * dormant (AD-234) got no settlement.open_ipo_escrow_campaign job, and that
 * job can also dead-letter; either way the offering has no readiness row and
 * refuses reservations. Each run opens (or, when the chain already shows it
 * open, records) the campaign for every offering still open for reservations
 * whose IPO deadline is ahead and whose campaign is not recorded, through the
 * same idempotent service the event job uses, with the same target (the
 * offering's target raise) and deadline (the case's ipo_end_at) the handoff
 * would have used.
 *
 * Only constructed where the property/IPO-escrow settlement bundle is
 * configured, so while settlement is dormant nothing runs and every offering
 * stays closed to reservations: activation is configuring that bundle.
 */
export class OpenPendingIpoEscrowCampaignsService {
  public constructor(
    private readonly repository: Pick<SettlementRepository, "findOfferingsAwaitingIpoEscrowCampaign">,
    private readonly openCampaign: Pick<OpenIpoEscrowCampaignService, "execute">,
    private readonly logger: Pick<Logger, "error">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async execute(traceId: string): Promise<OpenPendingIpoEscrowCampaignsSummary> {
    const pending = await this.repository.findOfferingsAwaitingIpoEscrowCampaign(this.now());
    const summary: OpenPendingIpoEscrowCampaignsSummary = {
      offeringsChecked: pending.length,
      campaignsReady: 0,
      campaignsNotReady: 0,
      errors: [],
    };

    // One at a time: each open waits for its receipt, and the operator
    // wallet's nonce is shared.
    for (const offering of pending) {
      try {
        const result = await this.openCampaign.execute({
          piv_id: offering.pivId,
          token_id: offering.tokenId,
          target_amount_eurc: toEurcMicros(offering.targetRaiseEur).toString(),
          deadline_unix: Math.floor(offering.ipoEndAt.getTime() / 1000),
          trace_id: traceId,
        });
        if (result.ready) {
          summary.campaignsReady += 1;
        } else {
          summary.campaignsNotReady += 1;
        }
      } catch (error) {
        // One failing campaign must not stop the others; the next run retries it.
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`piv_id=${offering.pivId}: ${message}`);
        this.logger.error(
          { err: error, trace_id: traceId, piv_id: offering.pivId, token_id: offering.tokenId },
          "opening a pending IPO escrow campaign failed",
        );
      }
    }

    return summary;
  }
}
