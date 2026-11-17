import type { Logger } from "pino";
import { z } from "zod";

import type { ChainClients } from "../../../infrastructure/blockchain/chain-client.js";
import type { OperatorKeyLock } from "../../../infrastructure/blockchain/operator-key-lock.js";
import {
  ipoEscrowCampaignStateFromChain,
  planIpoEscrowCampaignAction,
  type ExpectedIpoEscrowCampaign,
  type IpoEscrowCampaignAction,
  type IpoEscrowCampaignDifference,
  type ObservedIpoEscrowCampaign,
} from "../domain/ipo-escrow-campaign.policy.js";
import type { IpoEscrowCampaignRecord, SettlementRepository } from "../repository/settlement.repository.js";

// The job payload shape enqueued by PrismaOfferingRepository.openOfferingForApprovedCase,
// via the shared enqueue path (AD-145/AD-152).
export const openIpoEscrowCampaignJobSchema = z.object({
  piv_id: z.string().trim().min(1),
  token_id: z.string().trim().min(1),
  target_amount_eurc: z.string().trim().min(1),
  deadline_unix: z.number().int().positive(),
  trace_id: z.string().trim().min(1),
});

/**
 * Stable event names an operator alert rule keys on (with `severity`), never
 * the message. The mismatch one is an error: a campaign exists on-chain that is
 * not the offering's, and nothing here will adopt it.
 */
export const IPO_ESCROW_CAMPAIGN_ALERT_EVENTS = {
  mismatch: "settlement.ipo_escrow_campaign_mismatch",
} as const;

type CampaignOf = readonly [bigint, bigint, bigint, string, number, boolean];

/** What the offering would open its campaign with. */
export interface IpoEscrowCampaignRequest {
  pivId: string;
  tokenId: bigint;
  /** EURC base units (6 decimals). */
  targetAmount: bigint;
  /** Unix seconds. */
  deadline: bigint;
}

/** The chain's answer and the stored observation, with what an activation would do about them. Read-only. */
export interface IpoEscrowCampaignInspection {
  expected: ExpectedIpoEscrowCampaign;
  observed: ObservedIpoEscrowCampaign;
  /** When the chain was read. */
  observedAt: Date;
  recorded: IpoEscrowCampaignRecord | null;
  action: IpoEscrowCampaignAction;
}

export type IpoEscrowCampaignActivation =
  | { kind: "opened"; transactionHash: string }
  /** Open on-chain with the offering's parameters; the observation was recorded (adopted when nothing was recorded). */
  | { kind: "recorded_open"; adopted: boolean }
  /** Open on-chain with other parameters: refused, logged, nothing recorded. */
  | { kind: "refused_mismatch"; differences: IpoEscrowCampaignDifference[] }
  /** Successful or Failed on-chain: it takes no contribution. The stored observation, if any, now says so. */
  | { kind: "resolved"; state: "successful" | "failed"; recorded: boolean };

export interface OpenedIpoEscrowCampaign {
  pivId: string;
  tokenId: string;
  transactionHash: string | null;
  // True when the campaign is Open on-chain with the offering's parameters and
  // its observation is recorded, so the reservation gate (#176) sees it ready.
  // False when campaignOf shows it resolved (Successful or Failed): it cannot
  // take contributions any more.
  ready: boolean;
}

/**
 * A campaign that exists on-chain with parameters other than the offering's.
 * Retrying cannot change that: it needs an operator's decision.
 */
export class IpoEscrowCampaignMismatchError extends Error {
  public override readonly name = "IpoEscrowCampaignMismatchError";

  public constructor(
    public readonly pivId: string,
    public readonly differences: IpoEscrowCampaignDifference[],
  ) {
    super(
      `the IPO escrow campaign of piv_id=${pivId} exists on-chain with other parameters than the offering's and is ` +
        `not adopted: ${describeIpoEscrowCampaignDifferences(differences)}`,
    );
  }
}

export function describeIpoEscrowCampaignDifferences(differences: IpoEscrowCampaignDifference[]): string {
  return differences
    .map((difference) => `${difference.parameter} expected ${difference.expected}, found ${difference.actual}`)
    .join("; ");
}

/**
 * Opens an offering's IPO escrow campaign, or, when the chain already shows it
 * open with exactly the parameters the offering would use, records that
 * observation. Used by the operator command (AD-286: opening campaigns is an
 * explicit operator action) and by the settlement.open_ipo_escrow_campaign job
 * the offering handoff enqueues where the settlement bundle is configured.
 *
 * settlement.ipo_escrow_campaigns holds the last observation, which the
 * reservation gate reads (#176). Rules:
 *  - a campaign the chain does not show is opened, with the placeholder
 *    PIV_TREASURY_ADDRESS (C-008 question 3, the per-PIV treasury, is open);
 *  - an Open campaign is recorded only when its target, deadline, treasury and
 *    escrow contract equal what the offering would use. Another campaign is
 *    refused (nothing recorded, a structured error log with a stable event
 *    name), not adopted;
 *  - a Successful or Failed campaign is not recorded as ready; when a row
 *    exists it is moved to that state, so the offering stops being ready.
 *
 * The write that sends openCampaign runs under the operator-key lock, together
 * with the nonce read it makes (see OperatorKeyLock); the receipt wait does not.
 */
export class OpenIpoEscrowCampaignService {
  public constructor(
    private readonly chain: ChainClients,
    private readonly repository: Pick<
      SettlementRepository,
      "findIpoEscrowCampaign" | "recordIpoEscrowCampaignObservation" | "refreshIpoEscrowCampaignState"
    >,
    private readonly operatorKeyLock: OperatorKeyLock,
    private readonly logger: Pick<Logger, "error">,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The job entry point: opens or records, and fails the job where a retry cannot help. */
  public async execute(payload: unknown): Promise<OpenedIpoEscrowCampaign> {
    const parsed = openIpoEscrowCampaignJobSchema.parse(payload);
    const request: IpoEscrowCampaignRequest = {
      pivId: parsed.piv_id,
      tokenId: BigInt(parsed.token_id),
      targetAmount: BigInt(parsed.target_amount_eurc),
      deadline: BigInt(parsed.deadline_unix),
    };
    const result = await this.activate(request);
    const base = { pivId: parsed.piv_id, tokenId: parsed.token_id };
    switch (result.kind) {
      case "opened":
        return { ...base, transactionHash: result.transactionHash, ready: true };
      case "recorded_open":
        return { ...base, transactionHash: null, ready: true };
      case "resolved":
        return { ...base, transactionHash: null, ready: false };
      case "refused_mismatch":
        throw new IpoEscrowCampaignMismatchError(request.pivId, result.differences);
    }
  }

  /** What `activate` would do for this offering, from a read of the chain and of the stored observation. Writes nothing. */
  public async inspect(request: IpoEscrowCampaignRequest): Promise<IpoEscrowCampaignInspection> {
    const expected = this.expectedFor(request);
    const observed = await this.readCampaign(request.tokenId);
    // Taken after the read returned: the observation is as old as the answer.
    const observedAt = this.clock();
    const recorded = await this.repository.findIpoEscrowCampaign(request.pivId);
    const action = planIpoEscrowCampaignAction({
      expected,
      observed,
      recorded:
        recorded === null
          ? null
          : { escrowContractAddress: recorded.escrowContractAddress, observedState: recorded.observedState },
    });
    return { expected, observed, observedAt, recorded, action };
  }

  public async activate(request: IpoEscrowCampaignRequest): Promise<IpoEscrowCampaignActivation> {
    const inspection = await this.inspect(request);
    const { action } = inspection;
    switch (action.kind) {
      case "open":
        return this.open(request, inspection);
      case "record_open":
        await this.recordObservation(request, inspection.observed, inspection.observedAt, null);
        return { kind: "recorded_open", adopted: action.adopted };
      case "refuse_mismatch":
        this.logMismatch(request, action.differences);
        return { kind: "refused_mismatch", differences: action.differences };
      case "resolved": {
        const recorded = action.hasRow
          ? await this.repository.refreshIpoEscrowCampaignState({
              pivId: request.pivId,
              escrowContractAddress: inspection.expected.escrowContractAddress,
              state: action.state,
              observedAt: inspection.observedAt,
            })
          : false;
        return { kind: "resolved", state: action.state, recorded };
      }
    }
  }

  private async open(
    request: IpoEscrowCampaignRequest,
    before: IpoEscrowCampaignInspection,
  ): Promise<IpoEscrowCampaignActivation> {
    // Non-null assertions below: the ABI is loaded dynamically from the
    // compiled contract JSON (not a `const`-asserted TS literal), so viem
    // can't statically prove these named methods exist on .read/.write --
    // confirmed they do via contracts:export-abi's own output.
    const hash = await this.operatorKeyLock.run(() =>
      this.chain.ipoEscrow.write.openCampaign!([
        request.tokenId,
        request.targetAmount,
        request.deadline,
        before.expected.treasuryAddress as `0x${string}`,
      ]),
    );

    const receipt = await this.chain.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(
        `openCampaign transaction reverted for token_id=${request.tokenId} (piv_id=${request.pivId}, tx=${hash})`,
      );
    }

    // Recorded from a fresh campaignOf read, so the row holds the chain's
    // values even if they ever differ from what was asked for.
    const observed = await this.readCampaign(request.tokenId);
    const observedAt = this.clock();
    const after = planIpoEscrowCampaignAction({ expected: before.expected, observed, recorded: null });
    if (after.kind === "refuse_mismatch") {
      this.logMismatch(request, after.differences);
      return { kind: "refused_mismatch", differences: after.differences };
    }
    if (after.kind !== "record_open") {
      throw new Error(
        `openCampaign succeeded but campaignOf does not show the campaign open for token_id=${request.tokenId} (piv_id=${request.pivId}, tx=${hash})`,
      );
    }
    await this.recordObservation(request, observed, observedAt, hash);
    return { kind: "opened", transactionHash: hash };
  }

  private expectedFor(request: IpoEscrowCampaignRequest): ExpectedIpoEscrowCampaign {
    return {
      // Non-null: ipoEscrow below already throws if it were unset.
      escrowContractAddress: this.chain.config.ipoEscrowContractAddress!,
      targetAmount: request.targetAmount,
      deadline: request.deadline,
      // Non-null: pivTreasuryAddress is optional on ChainSettlementConfig
      // only so wallet-registry-only consumers can skip it (see
      // chain-client.ts) -- nothing constructs this service without the whole
      // property/IPO-escrow bundle configured together.
      treasuryAddress: this.chain.config.pivTreasuryAddress!,
    };
  }

  private async readCampaign(tokenId: bigint): Promise<ObservedIpoEscrowCampaign> {
    const [targetAmount, , deadline, treasury, state] = (await this.chain.ipoEscrow.read.campaignOf!([
      tokenId,
    ])) as CampaignOf;
    return {
      state: ipoEscrowCampaignStateFromChain(state),
      escrowContractAddress: this.chain.config.ipoEscrowContractAddress!,
      targetAmount,
      deadline,
      treasuryAddress: treasury,
    };
  }

  private async recordObservation(
    request: IpoEscrowCampaignRequest,
    observed: ObservedIpoEscrowCampaign,
    observedAt: Date,
    openTxHash: string | null,
  ): Promise<void> {
    await this.repository.recordIpoEscrowCampaignObservation({
      pivId: request.pivId,
      tokenId: request.tokenId.toString(),
      escrowContractAddress: observed.escrowContractAddress,
      targetAmount: observed.targetAmount,
      deadlineAt: new Date(Number(observed.deadline) * 1000),
      treasuryAddress: observed.treasuryAddress,
      openTxHash,
      state: observed.state,
      observedAt,
    });
  }

  private logMismatch(request: IpoEscrowCampaignRequest, differences: IpoEscrowCampaignDifference[]): void {
    this.logger.error(
      {
        event: IPO_ESCROW_CAMPAIGN_ALERT_EVENTS.mismatch,
        severity: "error",
        piv_id: request.pivId,
        token_id: request.tokenId.toString(),
        differences,
      },
      isRecordedForAnotherEscrowContract(differences)
        ? "the stored IPO escrow campaign observation of this offering was recorded for another escrow contract " +
            "(the contract was redeployed); it is not replaced, and the offering is not ready for reservations " +
            "until an operator removes it (docs/investor-offering.md)"
        : "an IPO escrow campaign exists on-chain with other parameters than the offering's; it is not adopted",
    );
  }
}

/**
 * Whether a refusal is about the stored observation and not about the chain:
 * the configured escrow contract is not the one the row was recorded for. (The
 * chain is always read from the configured contract, so on its own side the two
 * addresses cannot differ.)
 */
export function isRecordedForAnotherEscrowContract(differences: IpoEscrowCampaignDifference[]): boolean {
  return differences.some((difference) => difference.parameter === "escrow_address");
}
