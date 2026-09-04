import { z } from "zod";

import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";

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

export interface OpenedIpoEscrowCampaign {
  pivId: string;
  tokenId: string;
  transactionHash: string | null;
}

export class OpenIpoEscrowCampaignService {
  public constructor(private readonly chain: ChainClients) {}

  public async execute(payload: unknown): Promise<OpenedIpoEscrowCampaign> {
    const parsed = openIpoEscrowCampaignJobSchema.parse(payload);
    const tokenId = BigInt(parsed.token_id);

    // Non-null assertions below: the ABI is loaded dynamically from the
    // compiled contract JSON (not a `const`-asserted TS literal), so viem
    // can't statically prove these named methods exist on .read/.write --
    // confirmed they do via contracts:export-abi's own output.
    const existing = (await this.chain.ipoEscrow.read.campaignOf!([tokenId])) as readonly [
      bigint,
      bigint,
      bigint,
      string,
      number,
      boolean,
    ];
    const [, , , , state] = existing;
    if (state !== CAMPAIGN_STATE_NOT_OPENED) {
      // Idempotent replay: a prior attempt already opened this campaign
      // on-chain (or the job is being retried after its DB-side effects were
      // already durable) -- nothing left to do.
      return { pivId: parsed.piv_id, tokenId: parsed.token_id, transactionHash: null };
    }

    const hash = await this.chain.ipoEscrow.write.openCampaign!([
      tokenId,
      BigInt(parsed.target_amount_eurc),
      BigInt(parsed.deadline_unix),
      this.chain.config.pivTreasuryAddress,
    ]);

    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(
        `openCampaign transaction reverted for token_id=${parsed.token_id} (piv_id=${parsed.piv_id}, tx=${hash})`,
      );
    }

    return { pivId: parsed.piv_id, tokenId: parsed.token_id, transactionHash: hash };
  }
}
