import { z } from "zod";

import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";
import type { SettlementRepository } from "../repository/settlement.repository.js";

// The job payload shape enqueued by PrismaOfferingRepository.openOfferingForApprovedCase,
// via the shared enqueue path (AD-145/AD-152).
export const openIpoEscrowCampaignJobSchema = z.object({
  piv_id: z.string().trim().min(1),
  token_id: z.string().trim().min(1),
  target_amount_eurc: z.string().trim().min(1),
  deadline_unix: z.number().int().positive(),
  trace_id: z.string().trim().min(1),
});

// Mirrors VistaBloxIpoEscrow.sol's CampaignState enum ordering exactly.
const CAMPAIGN_STATE_NOT_OPENED = 0;
const CAMPAIGN_STATE_OPEN = 1;

type CampaignOf = readonly [bigint, bigint, bigint, string, number, boolean];

export interface OpenedIpoEscrowCampaign {
  pivId: string;
  tokenId: string;
  transactionHash: string | null;
  // True when the campaign is Open on-chain and its readiness row (the one
  // the reservation gate checks, #176) is recorded. False when campaignOf
  // already shows it resolved (Successful or Failed): it cannot take
  // contributions any more, so it is not recorded as ready.
  ready: boolean;
}

export class OpenIpoEscrowCampaignService {
  public constructor(
    private readonly chain: ChainClients,
    private readonly repository: Pick<SettlementRepository, "recordIpoEscrowCampaignOpened">,
  ) {}

  public async execute(payload: unknown): Promise<OpenedIpoEscrowCampaign> {
    const parsed = openIpoEscrowCampaignJobSchema.parse(payload);
    const tokenId = BigInt(parsed.token_id);

    // Non-null assertions below: the ABI is loaded dynamically from the
    // compiled contract JSON (not a `const`-asserted TS literal), so viem
    // can't statically prove these named methods exist on .read/.write --
    // confirmed they do via contracts:export-abi's own output.
    const existing = await this.readCampaign(tokenId);
    if (existing[4] !== CAMPAIGN_STATE_NOT_OPENED) {
      // Idempotent replay: a prior attempt already opened this campaign
      // on-chain. Its hash was not kept, so the readiness row (if it is
      // still missing) is recorded from what the chain holds.
      const ready = await this.recordIfOpen(parsed.piv_id, parsed.token_id, existing, null);
      return { pivId: parsed.piv_id, tokenId: parsed.token_id, transactionHash: null, ready };
    }

    const hash = await this.chain.ipoEscrow.write.openCampaign!([
      tokenId,
      BigInt(parsed.target_amount_eurc),
      BigInt(parsed.deadline_unix),
      // Non-null: pivTreasuryAddress is optional on ChainSettlementConfig
      // only so wallet-registry-only consumers can skip it (see
      // chain-client.ts) -- worker.ts never constructs this service without
      // the whole property/IPO-escrow bundle configured together.
      this.chain.config.pivTreasuryAddress!,
    ]);

    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(
        `openCampaign transaction reverted for token_id=${parsed.token_id} (piv_id=${parsed.piv_id}, tx=${hash})`,
      );
    }

    // Recorded from a fresh campaignOf read, so the row holds the chain's
    // values even if they ever differ from what was asked for.
    const opened = await this.readCampaign(tokenId);
    const ready = await this.recordIfOpen(parsed.piv_id, parsed.token_id, opened, hash);
    if (!ready) {
      throw new Error(
        `openCampaign succeeded but campaignOf does not show the campaign open for token_id=${parsed.token_id} (piv_id=${parsed.piv_id}, tx=${hash})`,
      );
    }
    return { pivId: parsed.piv_id, tokenId: parsed.token_id, transactionHash: hash, ready };
  }

  private async readCampaign(tokenId: bigint): Promise<CampaignOf> {
    return (await this.chain.ipoEscrow.read.campaignOf!([tokenId])) as CampaignOf;
  }

  private async recordIfOpen(
    pivId: string,
    tokenId: string,
    campaign: CampaignOf,
    openTxHash: string | null,
  ): Promise<boolean> {
    const [targetAmount, , deadline, treasury, state] = campaign;
    if (state !== CAMPAIGN_STATE_OPEN) return false;
    await this.repository.recordIpoEscrowCampaignOpened({
      pivId,
      tokenId,
      // Non-null: ipoEscrow above already threw if it were unset.
      escrowContractAddress: this.chain.config.ipoEscrowContractAddress!,
      targetAmount,
      deadlineAt: new Date(Number(deadline) * 1000),
      treasuryAddress: treasury,
      openTxHash,
    });
    return true;
  }
}
