import type { Logger } from "pino";

import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";
import { fromEurcMicros } from "../../../shared/domain/currency.js";
import { costBasisToUnitCount } from "../../../shared/domain/position.js";
import type { EscrowMintIntent, SettlementRepository } from "../repository/settlement.repository.js";

// Mirrors VistaBloxIpoEscrow.sol's CampaignState enum ordering exactly.
const CAMPAIGN_STATE_OPEN = 1;
const CAMPAIGN_STATE_SUCCESSFUL = 2;
const CAMPAIGN_STATE_FAILED = 3;

// A mint attempt that never recorded a transaction hash may have reached the
// node anyway (an RPC timeout, a crash right after the node accepted it), and
// nothing here can tell "never sent" from "sent and still pending". Another
// mint is therefore not sent until the attempt is this old and the contributor
// still holds nothing. This is a time-based assumption about how long a
// transaction can stay pending; it cannot be checked without a chain.
export const ESCROW_MINT_IN_FLIGHT_GRACE_MS = 30 * 60 * 1000;

// A mint cannot land before the chain head seen just before the attempt began;
// the margin only covers that head being re-organized. Bounds the log search
// that recovers a mint transaction hash after a crash (same idea as
// WALLET_REGISTRY_RESCAN_OVERLAP_BLOCKS).
const SEARCH_FROM_BLOCK_MARGIN = 32n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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
  // Of positionsMinted, the ones recorded for a mint that an earlier,
  // interrupted run had already sent: no new mint transaction was sent for them.
  mintsReconciled: number;
  errors: string[];
}

interface MintTarget {
  pivId: string;
  accountId: string;
  tokenId: bigint;
  walletAddress: string;
  mintAmount: bigint;
  tokenContractAddress: string;
  traceId: string;
}

// A mint known to have succeeded on-chain, and the intent that tracks it.
interface ConfirmedMint {
  intentId: string;
  txHash: string;
  sentThisRun: boolean;
}

/**
 * AD-256's finalize-and-mint half: for every PIV whose IPO deadline has
 * passed and whose escrow campaign isn't fully resolved yet (not swept),
 * finalize() it if still open, then either walk away (Failed -- each
 * contributor independently and permissionlessly withdraws their own
 * contribution; no VistaBlox action is required or possible) or mint each
 * contributor their proportional share and sweep the raised balance to the
 * PIV treasury (Successful).
 *
 * Minting is a chain write followed by a database write, and they cannot be
 * one transaction; VistaBloxProperty.mint is also not idempotent. So a rerun
 * after a crash is made safe by reconciling against durable state instead of
 * assuming either side is complete:
 *   - an escrow_mint_intents row is written BEFORE the mint is sent, and the
 *     transaction hash is written as soon as the node returns it;
 *   - the position, its mint event and the intent's `recorded` status are
 *     written in one database transaction, and the position carries a unique
 *     link to its intent, so recording cannot happen twice;
 *   - a rerun reads the chain first (the contributor's token balance, and
 *     the receipt of any recorded hash) and only sends a mint when the chain
 *     shows none exists and no earlier attempt can still be in flight. What it
 *     cannot prove safe, it refuses with an error naming the PIV, token and
 *     wallet, rather than guess.
 * A contributor who already has a position is never touched, so a crash
 * partway through a large contributor list is safe to simply re-run.
 */
export class FinalizeIpoEscrowCampaignsService {
  public constructor(
    private readonly repository: SettlementRepository,
    private readonly chain: ChainClients,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
    private readonly inFlightGraceMs: number = ESCROW_MINT_IN_FLIGHT_GRACE_MS,
  ) {}

  public async execute(traceId: string): Promise<FinalizeIpoEscrowCampaignsSummary> {
    const candidates = await this.repository.findPivsWithPassedIpoDeadline(this.clock());

    const summary: FinalizeIpoEscrowCampaignsSummary = {
      pivsChecked: candidates.length,
      campaignsFinalized: 0,
      campaignsSuccessful: 0,
      campaignsFailed: 0,
      positionsMinted: 0,
      mintsReconciled: 0,
      errors: [],
    };

    for (const candidate of candidates) {
      try {
        await this.processCampaign(candidate, summary, traceId);
      } catch (error) {
        summary.errors.push(
          `piv_id=${candidate.pivId} token_id=${candidate.tokenId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        this.logger.error(
          { err: error, trace_id: traceId, piv_id: candidate.pivId, token_id: candidate.tokenId },
          "escrow campaign finalization failed",
        );
      }
    }

    return summary;
  }

  private async processCampaign(
    candidate: { pivId: string; tokenId: string },
    summary: FinalizeIpoEscrowCampaignsSummary,
    traceId: string,
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
      const outcome = await this.mintForContributor(candidate.pivId, tokenId, walletAddress, traceId);
      if (outcome !== "skipped") summary.positionsMinted += 1;
      if (outcome === "reconciled") summary.mintsReconciled += 1;
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

  private async mintForContributor(
    pivId: string,
    tokenId: bigint,
    walletAddress: string,
    traceId: string,
  ): Promise<"skipped" | "minted" | "reconciled"> {
    const accountId = await this.repository.resolveAccountIdForWallet(walletAddress);
    if (accountId === null) {
      throw new Error(
        `No registered account found for contributor wallet ${walletAddress} (token_id=${tokenId}); ` +
          "cannot mint without a KYC-attributable account",
      );
    }

    if (await this.repository.hasPosition(pivId, accountId)) {
      return "skipped"; // Already minted and recorded on a prior, possibly-interrupted run.
    }

    const mintAmount = (await this.chain.ipoEscrow.read.contributionOf!([tokenId, walletAddress])) as bigint;
    if (mintAmount <= 0n) {
      throw new Error(`Contributor wallet ${walletAddress} has no contribution to mint (token_id=${tokenId})`);
    }

    const target: MintTarget = {
      pivId,
      accountId,
      tokenId,
      walletAddress,
      mintAmount,
      // Non-null: propertyContractAddress is optional on ChainSettlementConfig
      // only so wallet-registry-only consumers can skip it (see
      // chain-client.ts) -- worker.ts never constructs this service without
      // the whole property/IPO-escrow bundle configured together.
      tokenContractAddress: this.chain.config.propertyContractAddress!,
      traceId,
    };

    const mint = await this.obtainConfirmedMint(target);

    // AD-247's shared 1-unit-per-EUR convention:
    // unit_count == cost_basis_eur.
    const costBasisEur = fromEurcMicros(mintAmount);
    await this.repository.recordEscrowMintedPosition({
      escrowMintIntentId: mint.intentId,
      pivId,
      accountId,
      walletAddress,
      unitCount: costBasisToUnitCount(costBasisEur),
      costBasisEur,
      activatedAt: this.clock(),
      tokenContractAddress: target.tokenContractAddress,
      tokenId: tokenId.toString(),
      chainTxHash: mint.txHash,
    });

    return mint.sentThisRun ? "minted" : "reconciled";
  }

  /**
   * Returns a mint that is known to have succeeded on-chain for this
   * contributor, sending one only when the durable record and the chain
   * together show none exists and none can still be in flight.
   */
  private async obtainConfirmedMint(target: MintTarget): Promise<ConfirmedMint> {
    // Intent first, then the balance: the balance is then at least as fresh as
    // the intent state it is judged against, so a mint that lands in between is
    // seen rather than missed.
    const intent = await this.repository.findEscrowMintIntent(target.pivId, target.accountId);
    const balance = (await this.chain.property.read.balanceOf!([target.walletAddress, target.tokenId])) as bigint;

    if (intent === null) {
      // Nothing recorded. A zero balance means nothing was ever minted; a
      // balance equal to the contribution means a mint landed that this
      // database has no record of (an earlier run died between sending it and
      // recording it, including runs of the version before intents existed).
      return balance === 0n ? this.sendFirstMint(target) : this.adoptMintAlreadyOnChain(target, balance, null);
    }

    this.assertIntentMatchesTarget(intent, target);

    if (intent.status === "recorded") {
      // The position is written in the same transaction that sets this, and
      // the caller already found no position: the two disagree, and sending
      // another mint would compound whichever is wrong.
      throw new Error(
        `escrow mint intent ${intent.id} is recorded but no position exists for wallet ${target.walletAddress} ` +
          `(token_id=${target.tokenId}); not minting -- manual reconciliation required`,
      );
    }

    if (intent.status === "mint_sent") {
      return this.resolveSentMint(target, intent, balance);
    }

    return this.resolveInterruptedAttempt(target, intent, balance);
  }

  // The intent holds the hash of a mint transaction: look it up rather than
  // send another.
  private async resolveSentMint(
    target: MintTarget,
    intent: EscrowMintIntent,
    balance: bigint,
  ): Promise<ConfirmedMint> {
    const hash = intent.mintTxHash;
    if (hash === null) {
      throw new Error(`escrow mint intent ${intent.id} is mint_sent without a transaction hash`);
    }

    const receipt = await this.findReceipt(hash);
    if (receipt === null) {
      throw new Error(
        `mint transaction ${hash} for wallet ${target.walletAddress} (token_id=${target.tokenId}) has no receipt ` +
          "yet; not sending another mint while it may still be mined",
      );
    }
    if (receipt.status === "success") {
      return { intentId: intent.id, txHash: hash, sentThisRun: false };
    }

    // Reverted: the transaction changed no state, so the wallet should hold
    // nothing. If it does, something else minted and this must not compound it.
    if (balance !== 0n) {
      throw this.unexpectedBalance(target, balance, `its recorded mint transaction ${hash} reverted`);
    }
    this.logger.warn(
      {
        trace_id: target.traceId,
        piv_id: target.pivId,
        token_id: target.tokenId.toString(),
        wallet: target.walletAddress,
        tx_hash: hash,
      },
      "escrow mint transaction reverted; starting a new attempt",
    );
    return this.restartMint(target, intent);
  }

  // The intent says an attempt started but no hash was recorded: the mint may
  // or may not have been sent.
  private async resolveInterruptedAttempt(
    target: MintTarget,
    intent: EscrowMintIntent,
    balance: bigint,
  ): Promise<ConfirmedMint> {
    if (balance !== 0n) {
      return this.adoptMintAlreadyOnChain(target, balance, intent);
    }

    const retryAt = intent.attemptedAt.getTime() + this.inFlightGraceMs;
    if (this.clock().getTime() < retryAt) {
      throw new Error(
        `a mint attempt for wallet ${target.walletAddress} (token_id=${target.tokenId}) started at ` +
          `${intent.attemptedAt.toISOString()} recorded no transaction hash and may still be in flight; ` +
          `not sending another before ${new Date(retryAt).toISOString()}`,
      );
    }
    return this.restartMint(target, intent);
  }

  // The wallet already holds the minted tokens but this database has no
  // position for them: record the mint that is on-chain instead of sending a
  // second one.
  private async adoptMintAlreadyOnChain(
    target: MintTarget,
    balance: bigint,
    intent: EscrowMintIntent | null,
  ): Promise<ConfirmedMint> {
    if (balance !== target.mintAmount) {
      throw this.unexpectedBalance(target, balance, "no completed mint is recorded for it");
    }

    const hash = await this.findMintTransactionHash(target, intent?.searchFromBlock ?? null);
    if (hash === null) {
      throw new Error(
        `wallet ${target.walletAddress} already holds ${balance} of token_id=${target.tokenId} but the mint ` +
          "transaction could not be found in the chain logs; not minting -- manual reconciliation required",
      );
    }

    let current = intent;
    if (current === null) {
      const created = await this.repository.createEscrowMintIntent({
        pivId: target.pivId,
        accountId: target.accountId,
        walletAddress: target.walletAddress,
        tokenContractAddress: target.tokenContractAddress,
        tokenId: target.tokenId.toString(),
        mintAmount: target.mintAmount,
        attemptedAt: this.clock(),
        // The mint predates this record, so there is no block to bound it by.
        searchFromBlock: null,
      });
      if (!created.created) {
        throw this.claimedByAnotherRun(target);
      }
      current = created.intent;
    }

    await this.repository.recordEscrowMintSent({ intentId: current.id, attempt: current.attempt, txHash: hash });
    this.logger.warn(
      {
        trace_id: target.traceId,
        piv_id: target.pivId,
        token_id: target.tokenId.toString(),
        wallet: target.walletAddress,
        tx_hash: hash,
      },
      "recording an escrow mint that was already on-chain without a database record",
    );
    return { intentId: current.id, txHash: hash, sentThisRun: false };
  }

  private async sendFirstMint(target: MintTarget): Promise<ConfirmedMint> {
    await this.ensureHolderAuthorized(target);

    const head = await this.chain.publicClient.getBlockNumber();
    const created = await this.repository.createEscrowMintIntent({
      pivId: target.pivId,
      accountId: target.accountId,
      walletAddress: target.walletAddress,
      tokenContractAddress: target.tokenContractAddress,
      tokenId: target.tokenId.toString(),
      mintAmount: target.mintAmount,
      attemptedAt: this.clock(),
      searchFromBlock: head > SEARCH_FROM_BLOCK_MARGIN ? head - SEARCH_FROM_BLOCK_MARGIN : 0n,
    });
    if (!created.created) {
      throw this.claimedByAnotherRun(target);
    }
    return this.sendMint(target, created.intent.id, created.intent.attempt);
  }

  private async restartMint(target: MintTarget, intent: EscrowMintIntent): Promise<ConfirmedMint> {
    await this.ensureHolderAuthorized(target);

    const restarted = await this.repository.restartEscrowMintAttempt({
      intentId: intent.id,
      expectedAttempt: intent.attempt,
      attemptedAt: this.clock(),
    });
    if (!restarted) {
      throw this.claimedByAnotherRun(target);
    }
    return this.sendMint(target, intent.id, intent.attempt + 1);
  }

  // The intent is already durable and on `attempt` when this is called. The
  // hash is recorded the moment the node returns it, before the receipt wait.
  private async sendMint(target: MintTarget, intentId: string, attempt: number): Promise<ConfirmedMint> {
    const hash = await this.chain.property.write.mint!([
      target.walletAddress,
      target.tokenId,
      target.mintAmount,
      "0x",
    ]);

    try {
      await this.repository.recordEscrowMintSent({ intentId, attempt, txHash: hash });
    } catch (error) {
      // The mint is on its way to the chain but its hash is not durable. Say
      // so loudly with the hash: the next run recovers it from the chain logs,
      // and an operator can look it up directly.
      throw new Error(
        `mint transaction ${hash} for wallet ${target.walletAddress} (token_id=${target.tokenId}) was sent but ` +
          `its hash could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`mint transaction reverted for ${target.walletAddress} (tx=${hash})`);
    }
    return { intentId, txHash: hash, sentThisRun: true };
  }

  // authorizeHolder only sets a flag, so repeating it is harmless; the view
  // check just avoids paying for a transaction that changes nothing.
  private async ensureHolderAuthorized(target: MintTarget): Promise<void> {
    const authorized = (await this.chain.property.read.isHolderAuthorized!([
      target.walletAddress,
      target.tokenId,
    ])) as boolean;
    if (authorized) return;

    const hash = await this.chain.property.write.authorizeHolder!([target.walletAddress, target.tokenId]);
    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`authorizeHolder transaction reverted for ${target.walletAddress} (tx=${hash})`);
    }
  }

  private async findReceipt(hash: string): Promise<{ status: string } | null> {
    try {
      return await this.chain.publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
    } catch (error) {
      // viem throws TransactionReceiptNotFoundError for a transaction that is
      // pending or unknown; anything else (an RPC failure) must not be read
      // as "not mined".
      if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return null;
      throw error;
    }
  }

  // The hash of the mint of exactly this token amount to this wallet, from the
  // token's TransferSingle logs. Null when there is not exactly one.
  private async findMintTransactionHash(target: MintTarget, fromBlock: bigint | null): Promise<string | null> {
    const logs = (await this.chain.property.getEvents.TransferSingle!(
      { from: ZERO_ADDRESS, to: target.walletAddress },
      { fromBlock: fromBlock ?? 0n },
    )) as unknown as ReadonlyArray<{
      args: { id?: bigint; value?: bigint };
      transactionHash: string;
    }>;
    const matches = logs.filter((log) => log.args.id === target.tokenId && log.args.value === target.mintAmount);
    return matches.length === 1 ? (matches[0]?.transactionHash ?? null) : null;
  }

  private assertIntentMatchesTarget(intent: EscrowMintIntent, target: MintTarget): void {
    const sameWallet = intent.walletAddress.toLowerCase() === target.walletAddress.toLowerCase();
    const sameContract = intent.tokenContractAddress.toLowerCase() === target.tokenContractAddress.toLowerCase();
    if (
      !sameWallet ||
      !sameContract ||
      intent.tokenId !== target.tokenId.toString() ||
      intent.mintAmount !== target.mintAmount
    ) {
      throw new Error(
        `escrow mint intent ${intent.id} (wallet ${intent.walletAddress}, contract ${intent.tokenContractAddress}, ` +
          `token_id=${intent.tokenId}, amount ${intent.mintAmount}) does not match the contribution now on-chain ` +
          `(wallet ${target.walletAddress}, contract ${target.tokenContractAddress}, token_id=${target.tokenId}, ` +
          `amount ${target.mintAmount}); not minting -- manual reconciliation required`,
      );
    }
  }

  private unexpectedBalance(target: MintTarget, balance: bigint, why: string): Error {
    return new Error(
      `wallet ${target.walletAddress} holds ${balance} of token_id=${target.tokenId} against a contribution of ` +
        `${target.mintAmount}, and ${why}; not minting -- manual reconciliation required`,
    );
  }

  private claimedByAnotherRun(target: MintTarget): Error {
    return new Error(
      `another run already claimed the mint for wallet ${target.walletAddress} (token_id=${target.tokenId}); ` +
        "leaving it to that run",
    );
  }
}
