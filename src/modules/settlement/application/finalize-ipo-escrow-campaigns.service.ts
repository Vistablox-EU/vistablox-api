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
// node anyway (an RPC timeout, a crash right after the node accepted it). Every
// attempt therefore pins the operator nonce its mint is sent with, and writes
// it to the intent before sending. A later run reconciles against the chain
// instead of a clock (resolveInterruptedAttempt):
//   - a TransferSingle mint log for the contribution means the mint landed;
//   - no log, and the operator's confirmed nonce has passed the pinned one:
//     that nonce was used by a transaction that did not mint (a revert, a
//     replacement), so the mint can never land and a new attempt is sent;
//   - no log, and the nonce not yet passed: the mint is resent with the SAME
//     nonce. At most one transaction per nonce is ever mined, so if the
//     original is still pending the node rejects the resend (or one replaces
//     the other) and never are both minted.
//
// This is the time-based rule that applied before nonces were pinned. It is
// kept only for intents written then (mint_nonce NULL): another mint is not
// sent until such an attempt is this old and the contributor still holds
// nothing, an assumption about how long a transaction can stay pending.
//
// Neither rule is proof against VistaBloxProperty.burn (BURNER_ROLE) or
// forceTransfer (TRANSFER_AGENT_ROLE) emptying the wallet: with a pinned nonce
// a mint log with nothing left in the wallet is refused for manual
// reconciliation; under the legacy rule an emptied, unrecorded mint whose log
// is not found is sent again.
export const ESCROW_MINT_IN_FLIGHT_GRACE_MS = 30 * 60 * 1000;

// Which block the operator's "confirmed" nonce is read at when deciding that a
// pinned nonce was used by a transaction that did not mint. "finalized" is the
// conservative default: a block that a reorg could still drop is never taken as
// evidence, at the cost of waiting for L1 finality before such an attempt is
// replaced. ESCROW_MINT_NONCE_BLOCK_TAG overrides it.
export const ESCROW_MINT_NONCE_BLOCK_TAGS = ["finalized", "safe", "latest"] as const;
export type EscrowMintNonceBlockTag = (typeof ESCROW_MINT_NONCE_BLOCK_TAGS)[number];
export const DEFAULT_ESCROW_MINT_NONCE_BLOCK_TAG: EscrowMintNonceBlockTag = "finalized";

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

export interface FinalizeIpoEscrowCampaignsOptions {
  // Applies only to intents written before mint nonces were pinned.
  inFlightGraceMs?: number;
  nonceBlockTag?: EscrowMintNonceBlockTag;
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
 *   - every attempt pins the operator nonce its mint is sent with and writes
 *     it to the intent first, so at most one transaction of that attempt can
 *     ever be mined;
 *   - a rerun reads the chain first (the contributor's token balance, the
 *     receipt of any recorded hash, the mint logs and the operator's confirmed
 *     nonce) and only sends a mint when the chain shows none exists and no
 *     earlier attempt can still land. What it
 *     cannot prove safe, it refuses with an error naming the PIV, token and
 *     wallet, rather than guess.
 * A contributor who already has a position is never touched, so a crash
 * partway through a large contributor list is safe to simply re-run -- as
 * long as the campaign is not swept in between by someone else (see the swept
 * check in processCampaign).
 */
export class FinalizeIpoEscrowCampaignsService {
  public constructor(
    private readonly repository: SettlementRepository,
    private readonly chain: ChainClients,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
    options: FinalizeIpoEscrowCampaignsOptions = {},
  ) {
    this.inFlightGraceMs = options.inFlightGraceMs ?? ESCROW_MINT_IN_FLIGHT_GRACE_MS;
    this.nonceBlockTag = options.nonceBlockTag ?? DEFAULT_ESCROW_MINT_NONCE_BLOCK_TAG;
  }

  private readonly inFlightGraceMs: number;
  private readonly nonceBlockTag: EscrowMintNonceBlockTag;

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
      // This job mints every contributor before it sweeps, so a campaign it
      // swept itself is fully processed. But withdrawRaised is permissionless:
      // a sweep by anyone else, before the mints, also lands here, and any
      // contributor not yet minted stays unminted. Walking swept campaigns
      // would repair that, but means re-walking every swept campaign's
      // contributors on every run with no durable "fully minted" marker to
      // stop on, so it is left as a known gap rather than decided here.
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
    if (mint === null) return "skipped";

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
   * together show none exists and none can still be in flight. Null when the
   * position turns out to have been recorded already (by an overlapping run).
   */
  private async obtainConfirmedMint(target: MintTarget): Promise<ConfirmedMint | null> {
    // Intent first, then the balance: the balance is then at least as fresh as
    // the intent state it is judged against, so a mint that lands in between is
    // seen rather than missed.
    const intent = await this.repository.findEscrowMintIntent(target.pivId, target.accountId);
    const balance = (await this.chain.property.read.balanceOf!([target.walletAddress, target.tokenId])) as bigint;

    if (intent === null) {
      // Nothing recorded. A zero balance is taken to mean nothing was minted
      // (a burn or forceTransfer of an unrecorded mint is not ruled out); a
      // balance equal to the contribution means a mint landed that this
      // database has no record of (an earlier run died between sending it and
      // recording it, including runs of the version before intents existed).
      return balance === 0n ? this.sendFirstMint(target) : this.adoptMintAlreadyOnChain(target, balance, null);
    }

    this.assertIntentMatchesTarget(intent, target);

    if (intent.status === "recorded") {
      // The position is written in the same transaction that sets this. The
      // caller found none a few reads ago, so either an overlapping run has
      // committed it since (done) or the two really disagree.
      if (await this.repository.hasPosition(target.pivId, target.accountId)) return null;
      // They disagree, and sending another mint would compound whichever is wrong.
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
  // or may not have been sent. See ESCROW_MINT_IN_FLIGHT_GRACE_MS.
  private async resolveInterruptedAttempt(
    target: MintTarget,
    intent: EscrowMintIntent,
    balance: bigint,
  ): Promise<ConfirmedMint> {
    if (intent.mintNonce === null) {
      return this.resolveLegacyInterruptedAttempt(target, intent, balance);
    }
    const pinnedNonce = intent.mintNonce;

    // The nonce before the logs: a mint mined at or below the nonce read here
    // is then in the logs read next, so "nonce passed, no log" cannot be a
    // mint that landed in between.
    const confirmedNonce = BigInt(
      await this.chain.publicClient.getTransactionCount({
        address: this.chain.operatorAddress,
        blockTag: this.nonceBlockTag,
      }),
    );
    const mintLogs = await this.findMintLogs(target, intent.searchFromBlock);
    // Read again after the logs, so it is at least as fresh as they are.
    const currentBalance = (await this.chain.property.read.balanceOf!([
      target.walletAddress,
      target.tokenId,
    ])) as bigint;

    if (mintLogs.length > 1) {
      throw new Error(
        `found ${mintLogs.length} mint logs of ${target.mintAmount} of token_id=${target.tokenId} to wallet ` +
          `${target.walletAddress}; not minting -- manual reconciliation required`,
      );
    }
    const [mintLog] = mintLogs;
    if (mintLog !== undefined) {
      if (currentBalance !== target.mintAmount) {
        throw this.unexpectedBalance(target, currentBalance, `its mint transaction ${mintLog} is on-chain`);
      }
      return this.adoptMintLog(target, intent, mintLog);
    }
    if (currentBalance !== 0n) {
      return this.adoptMintAlreadyOnChain(target, currentBalance, intent);
    }

    if (confirmedNonce > pinnedNonce) {
      // The pinned nonce was used by a transaction that minted nothing.
      this.logger.warn(
        {
          trace_id: target.traceId,
          piv_id: target.pivId,
          token_id: target.tokenId.toString(),
          wallet: target.walletAddress,
          mint_nonce: pinnedNonce.toString(),
        },
        "escrow mint attempt's nonce was used without a mint; starting a new attempt",
      );
      return this.restartMint(target, intent);
    }
    // The original may still be pending under this nonce: resend under the
    // same one, so the chain can mine at most one of them.
    return this.restartMint(target, intent, pinnedNonce);
  }

  private async resolveLegacyInterruptedAttempt(
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

    if (intent !== null) return this.adoptMintLog(target, intent, hash);

    const created = await this.repository.createEscrowMintIntent({
      pivId: target.pivId,
      accountId: target.accountId,
      walletAddress: target.walletAddress,
      tokenContractAddress: target.tokenContractAddress,
      tokenId: target.tokenId.toString(),
      mintAmount: target.mintAmount,
      attemptedAt: this.clock(),
      // The mint predates this record, so there is no block to bound it by
      // and no nonce this service chose.
      searchFromBlock: null,
      mintNonce: null,
    });
    if (!created.created) {
      throw this.claimedByAnotherRun(target);
    }
    return this.adoptMintLog(target, created.intent, hash);
  }

  // Records `hash`, a mint found in the chain logs, as the intent's mint.
  private async adoptMintLog(target: MintTarget, intent: EscrowMintIntent, hash: string): Promise<ConfirmedMint> {
    await this.repository.recordEscrowMintSent({ intentId: intent.id, attempt: intent.attempt, txHash: hash });
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
    return { intentId: intent.id, txHash: hash, sentThisRun: false };
  }

  private async sendFirstMint(target: MintTarget): Promise<ConfirmedMint> {
    await this.ensureHolderAuthorized(target);

    const head = await this.chain.publicClient.getBlockNumber();
    const nonce = await this.nextOperatorNonce();
    const created = await this.repository.createEscrowMintIntent({
      pivId: target.pivId,
      accountId: target.accountId,
      walletAddress: target.walletAddress,
      tokenContractAddress: target.tokenContractAddress,
      tokenId: target.tokenId.toString(),
      mintAmount: target.mintAmount,
      attemptedAt: this.clock(),
      searchFromBlock: head > SEARCH_FROM_BLOCK_MARGIN ? head - SEARCH_FROM_BLOCK_MARGIN : 0n,
      mintNonce: nonce,
    });
    if (!created.created) {
      throw this.claimedByAnotherRun(target);
    }
    return this.sendMint(target, created.intent.id, created.intent.attempt, nonce);
  }

  // Starts the next attempt under `reuseNonce` when the previous attempt's
  // mint may still be pending under it, otherwise under a fresh nonce.
  private async restartMint(
    target: MintTarget,
    intent: EscrowMintIntent,
    reuseNonce?: bigint,
  ): Promise<ConfirmedMint> {
    await this.ensureHolderAuthorized(target);

    const nonce = reuseNonce ?? (await this.nextOperatorNonce());
    const restarted = await this.repository.restartEscrowMintAttempt({
      intentId: intent.id,
      expectedAttempt: intent.attempt,
      attemptedAt: this.clock(),
      mintNonce: nonce,
    });
    if (!restarted) {
      throw this.claimedByAnotherRun(target);
    }
    return this.sendMint(target, intent.id, intent.attempt + 1, nonce);
  }

  // The operator's next nonce, counting transactions still in the mempool. Read
  // after any authorizeHolder transaction has been mined.
  private async nextOperatorNonce(): Promise<bigint> {
    return BigInt(
      await this.chain.publicClient.getTransactionCount({
        address: this.chain.operatorAddress,
        blockTag: "pending",
      }),
    );
  }

  // The intent is already durable on `attempt`, with `nonce`, when this is
  // called. The hash is recorded the moment the node returns it, before the
  // receipt wait.
  private async sendMint(
    target: MintTarget,
    intentId: string,
    attempt: number,
    nonce: bigint,
  ): Promise<ConfirmedMint> {
    const hash = await this.chain.property.write.mint!(
      [target.walletAddress, target.tokenId, target.mintAmount, "0x"],
      { nonce: Number(nonce) },
    );

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
    // When another transaction from the same account and nonce takes this one's
    // place (a speed-up, a cancel, a colliding operator transaction), viem
    // resolves the wait with the REPLACEMENT's receipt. Its status says nothing
    // about whether this mint executed, so it is not evidence of one.
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new Error(
        `mint transaction ${hash} was replaced by transaction ${receipt.transactionHash} (wallet ` +
          `${target.walletAddress}, token_id=${target.tokenId}); not recording a position for it -- manual ` +
          "reconciliation required",
      );
    }
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
    const matches = await this.findMintLogs(target, fromBlock);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }

  // The hashes of every mint of exactly this token amount to this wallet.
  private async findMintLogs(target: MintTarget, fromBlock: bigint | null): Promise<string[]> {
    const logs = (await this.chain.property.getEvents.TransferSingle!(
      { from: ZERO_ADDRESS, to: target.walletAddress },
      { fromBlock: fromBlock ?? 0n },
    )) as unknown as ReadonlyArray<{
      args: { id?: bigint; value?: bigint };
      transactionHash: string;
    }>;
    return logs
      .filter((log) => log.args.id === target.tokenId && log.args.value === target.mintAmount)
      .map((log) => log.transactionHash);
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
