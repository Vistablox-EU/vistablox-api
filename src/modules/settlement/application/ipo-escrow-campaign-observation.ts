import type { Logger } from "pino";

import { ipoEscrowCampaignStateFromChain } from "../domain/ipo-escrow-campaign.policy.js";
import type { SettlementRepository } from "../repository/settlement.repository.js";

export const IPO_ESCROW_CAMPAIGN_OBSERVATION_FAILED_EVENT = "settlement.ipo_escrow_campaign_observation_failed";

/**
 * The cheap refresh a reader that has just read campaignOf records (AD-286): it
 * moves the stored observation of an offering's IPO escrow campaign to the
 * state the chain showed, so an offering whose campaign is no longer Open stops
 * being ready for reservations. The finalizer calls it when it sees a campaign
 * that is not Open. It only updates a row that exists, it never reads the
 * chain itself, and an Open state is not recorded here: the operator command
 * does that, after comparing the campaign's parameters with the offering's.
 *
 * It never throws. The caller is deciding something else (minting positions for
 * a Successful campaign) and must not stop because a status row could not be
 * written; the failure is logged under a stable event name instead, and the
 * gate still closes on the stored deadline.
 */
export async function recordObservedIpoEscrowCampaignState(
  dependencies: {
    repository: Pick<SettlementRepository, "refreshIpoEscrowCampaignState">;
    logger: Pick<Logger, "error">;
  },
  input: { pivId: string; tokenId: string; stateCode: number; observedAt: Date; traceId: string },
): Promise<void> {
  try {
    const state = ipoEscrowCampaignStateFromChain(input.stateCode);
    if (state === "open") return;
    await dependencies.repository.refreshIpoEscrowCampaignState({
      pivId: input.pivId,
      state,
      observedAt: input.observedAt,
    });
  } catch (error) {
    dependencies.logger.error(
      {
        event: IPO_ESCROW_CAMPAIGN_OBSERVATION_FAILED_EVENT,
        severity: "error",
        err: error,
        trace_id: input.traceId,
        piv_id: input.pivId,
        token_id: input.tokenId,
      },
      "could not record the state of an IPO escrow campaign the finalizer read",
    );
  }
}
