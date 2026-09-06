import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";
import { fromEurcMicros } from "../../../shared/domain/currency.js";
import { costBasisToUnitCount } from "../../../shared/domain/position.js";
import type { SettlementRepository } from "../repository/settlement.repository.js";

// Mirrors VistaBloxIpoEscrow.sol's CampaignState enum ordering exactly.
const CAMPAIGN_STATE_OPEN = 1;
const CAMPAIGN_STATE_SUCCESSFUL = 2;
const CAMPAIGN_STATE_FAILED = 3;

interface Campaign {
  targetAmount: bigint;
  totalRaised: bigint;
  deadline: bigint;
  treasury: string;
  state: number;
  swept: boolean;
}

export interface FinalizeIpoEscrowCampaignsSummary {
  pivsChecked: number;
  campaignsFinalized: number;
  campaignsSuccessful: number;
  campaignsFailed: number;
  positionsMinted: number;
  errors: string[];
}

/**
 * AD-256's finalize-and-mint half: for every PIV whose IPO deadline has
 * passed and whose escrow campaign isn't fully resolved yet (not swept),
 * finalize() it if still open, then either walk away (Failed -- each
 * contributor independently and permissionlessly withdraws their own
 * contribution; no VistaBlox action is required or possible) or mint each
 * contributor their proportional share and sweep the raised balance to the
 * PIV treasury (Successful). Resumable per contributor: a mint already
 * reflected in position_ledger is never repeated, so a crash partway
 * through a large contributor list is safe to simply re-run.
 */
export class FinalizeIpoEscrowCampaignsService {
  public constructor(
    private readonly repository: SettlementRepository,
    private readonly chain: ChainClients,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async execute(): Promise<FinalizeIpoEscrowCampaignsSummary> {
    const candidates = await this.repository.findPivsWithPassedIpoDeadline(this.clock());

    const summary: FinalizeIpoEscrowCampaignsSummary = {
      pivsChecked: candidates.length,
      campaignsFinalized: 0,
      campaignsSuccessful: 0,
      campaignsFailed: 0,
      positionsMinted: 0,
      errors: [],
    };

    for (const candidate of candidates) {
      try {
        await this.processCampaign(candidate, summary);
      } catch (error) {
        summary.errors.push(
          `piv_id=${candidate.pivId} token_id=${candidate.tokenId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return summary;
  }

  private async processCampaign(
    candidate: { pivId: string; tokenId: string },
    summary: FinalizeIpoEscrowCampaignsSummary,
  ): Promise<void> {
    const tokenId = BigInt(candidate.tokenId);
    let campaign = await this.readCampaign(tokenId);

    if (campaign.swept) {
      // Minting and the treasury sweep both happen before swept is set --
      // already fully processed.
      return;
    }

    if (campaign.state === CAMPAIGN_STATE_OPEN) {
      const hash = await this.chain.ipoEscrow.write.finalize!([tokenId]);
      const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`finalize transaction reverted (tx=${hash})`);
      }
      summary.campaignsFinalized += 1;
      campaign = await this.readCampaign(tokenId);
    }

    if (campaign.state === CAMPAIGN_STATE_FAILED) {
      summary.campaignsFailed += 1;
      return;
    }

    if (campaign.state !== CAMPAIGN_STATE_SUCCESSFUL) {
      return;
    }

    summary.campaignsSuccessful += 1;

    const contributors = (await this.chain.ipoEscrow.read.contributorsOf!([tokenId])) as readonly string[];
    for (const walletAddress of contributors) {
      const minted = await this.mintForContributor(candidate.pivId, tokenId, walletAddress);
      if (minted) summary.positionsMinted += 1;
    }

    const hash = await this.chain.ipoEscrow.write.withdrawRaised!([tokenId]);
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`withdrawRaised transaction reverted (tx=${hash})`);
    }
  }

  private async readCampaign(tokenId: bigint): Promise<Campaign> {
    const result = (await this.chain.ipoEscrow.read.campaignOf!([tokenId])) as readonly [
      bigint,
      bigint,
      bigint,
      string,
      number,
      boolean,
    ];
    const [targetAmount, totalRaised, deadline, treasury, state, swept] = result;
    return { targetAmount, totalRaised, deadline, treasury, state, swept };
  }

  private async mintForContributor(pivId: string, tokenId: bigint, walletAddress: string): Promise<boolean> {
    const accountId = await this.repository.resolveAccountIdForWallet(walletAddress);
    if (accountId === null) {
      throw new Error(
        `No registered account found for contributor wallet ${walletAddress} (token_id=${tokenId}); ` +
          "cannot mint without a KYC-attributable account",
      );
    }

    if (await this.repository.hasPosition(pivId, accountId)) {
      return false; // Already minted for this investor on a prior, possibly-interrupted run.
    }

    const amount = (await this.chain.ipoEscrow.read.contributionOf!([tokenId, walletAddress])) as bigint;

    const authorizeHash = await this.chain.property.write.authorizeHolder!([walletAddress, tokenId]);
    await this.chain.publicClient.waitForTransactionReceipt({ hash: authorizeHash });

    const mintHash = await this.chain.property.write.mint!([walletAddress, tokenId, amount, "0x"]);
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash: mintHash });
    if (receipt.status !== "success") {
      throw new Error(`mint transaction reverted for ${walletAddress} (tx=${mintHash})`);
    }

    // AD-247's shared 1-unit-per-EUR convention:
    // unit_count == cost_basis_eur.
    const costBasisEur = fromEurcMicros(amount);
    await this.repository.recordEscrowMintedPosition({
      pivId,
      accountId,
      walletAddress,
      unitCount: costBasisToUnitCount(costBasisEur),
      costBasisEur,
      activatedAt: this.clock(),
      tokenContractAddress: this.chain.config.propertyContractAddress,
      tokenId: tokenId.toString(),
      chainTxHash: mintHash,
    });

    return true;
  }
}
