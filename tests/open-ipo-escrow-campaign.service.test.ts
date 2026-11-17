import { describe, expect, it, vi } from "vitest";

import {
  IPO_ESCROW_CAMPAIGN_ALERT_EVENTS,
  IpoEscrowCampaignMismatchError,
  OpenIpoEscrowCampaignService,
  type IpoEscrowCampaignRequest,
} from "../src/modules/settlement/application/open-ipo-escrow-campaign.service.js";
import type {
  IpoEscrowCampaignRecord,
  RecordIpoEscrowCampaignObservationInput,
  RefreshIpoEscrowCampaignStateInput,
} from "../src/modules/settlement/repository/settlement.repository.js";
import { makeCapturingLogger } from "./support/escrow-mint-fakes.js";
import { InProcessOperatorKeyLock } from "./support/operator-key-lock-fakes.js";

const ESCROW = "0x00000000000000000000000000000000000E5c20";
const OTHER_ESCROW = "0x00000000000000000000000000000000000E5c21";
const TREASURY = "0x000000000000000000000000000000000000Ba5e";
const OTHER_TREASURY = "0x000000000000000000000000000000000000Ba5f";
const TX_HASH = `0x${"ab".repeat(32)}`;
const DEADLINE_UNIX = 1_790_000_000;
const TARGET = 500_000_000_000n;
const NOW = new Date("2026-10-01T12:00:00.000Z");

type CampaignOf = readonly [bigint, bigint, bigint, string, number, boolean];

// campaignOf reads in order: the pre-check, then (after a send) the re-read.
function chain(options: { reads: CampaignOf[]; receiptStatus?: "success" | "reverted"; timeline?: string[] }) {
  const timeline = options.timeline ?? [];
  const reads = [...options.reads];
  const openCampaign = vi.fn(async (_args: unknown[]) => {
    timeline.push("chain:openCampaign");
    return TX_HASH;
  });
  const clients = {
    config: { ipoEscrowContractAddress: ESCROW, pivTreasuryAddress: TREASURY },
    ipoEscrow: {
      read: {
        campaignOf: vi.fn(async () => {
          const next = reads.shift();
          if (next === undefined) throw new Error("unexpected campaignOf read");
          return next;
        }),
      },
      write: { openCampaign },
    },
    publicClient: {
      waitForTransactionReceipt: vi.fn(async () => {
        timeline.push("chain:waitForReceipt");
        return { status: options.receiptStatus ?? "success" };
      }),
    },
  };
  return { clients, openCampaign, timeline };
}

function repository(initial: IpoEscrowCampaignRecord | null = null) {
  let row = initial;
  const observations: RecordIpoEscrowCampaignObservationInput[] = [];
  const refreshes: RefreshIpoEscrowCampaignStateInput[] = [];
  return {
    get row() {
      return row;
    },
    observations,
    refreshes,
    findIpoEscrowCampaign: vi.fn(async () => row),
    recordIpoEscrowCampaignObservation: vi.fn(async (input: RecordIpoEscrowCampaignObservationInput) => {
      observations.push(input);
    }),
    refreshIpoEscrowCampaignState: vi.fn(async (input: RefreshIpoEscrowCampaignStateInput) => {
      refreshes.push(input);
      if (row === null) return false;
      row = { ...row, observedState: input.state, observedAt: input.observedAt };
      return true;
    }),
  };
}

function recordedRow(overrides: Partial<IpoEscrowCampaignRecord> = {}): IpoEscrowCampaignRecord {
  return {
    pivId: "piv_1",
    tokenId: "7",
    escrowContractAddress: ESCROW.toLowerCase(),
    targetAmount: TARGET,
    deadlineAt: new Date(DEADLINE_UNIX * 1000),
    treasuryAddress: TREASURY.toLowerCase(),
    openTxHash: TX_HASH,
    observedState: "open",
    observedAt: new Date("2026-09-30T12:00:00.000Z"),
    ...overrides,
  };
}

function service(
  c: ReturnType<typeof chain>,
  repo: ReturnType<typeof repository>,
  options: { timeline?: string[] } = {},
) {
  const { logger, entries } = makeCapturingLogger();
  const lock = new InProcessOperatorKeyLock(options.timeline ?? c.timeline);
  return {
    entries,
    lock,
    service: new OpenIpoEscrowCampaignService(c.clients as never, repo, lock, logger, () => NOW),
  };
}

const notOpened: CampaignOf = [0n, 0n, 0n, "0x0000000000000000000000000000000000000000", 0, false];
const open: CampaignOf = [TARGET, 0n, BigInt(DEADLINE_UNIX), TREASURY, 1, false];

const payload = {
  piv_id: "piv_1",
  token_id: "7",
  target_amount_eurc: TARGET.toString(),
  deadline_unix: DEADLINE_UNIX,
  trace_id: "req_test",
};

const request: IpoEscrowCampaignRequest = {
  pivId: "piv_1",
  tokenId: 7n,
  targetAmount: TARGET,
  deadline: BigInt(DEADLINE_UNIX),
};

describe("OpenIpoEscrowCampaignService: opening and recording the observation the reservation gate reads", () => {
  it("opens a new campaign with the placeholder treasury and records what the chain then shows, with the open tx hash", async () => {
    const c = chain({ reads: [notOpened, open] });
    const repo = repository();

    const result = await service(c, repo).service.execute(payload);

    expect(c.openCampaign).toHaveBeenCalledWith([7n, TARGET, BigInt(DEADLINE_UNIX), TREASURY]);
    expect(result).toEqual({ pivId: "piv_1", tokenId: "7", transactionHash: TX_HASH, ready: true });
    expect(repo.observations).toEqual([
      {
        pivId: "piv_1",
        tokenId: "7",
        escrowContractAddress: ESCROW,
        targetAmount: TARGET,
        deadlineAt: new Date(DEADLINE_UNIX * 1000),
        treasuryAddress: TREASURY,
        openTxHash: TX_HASH,
        state: "open",
        observedAt: NOW,
      },
    ]);
  });

  it("sends openCampaign inside the operator-key lock and waits for the receipt after releasing it", async () => {
    const c = chain({ reads: [notOpened, open] });

    await service(c, repository()).service.execute(payload);

    expect(c.timeline).toEqual(["lock:enter", "chain:openCampaign", "lock:exit", "chain:waitForReceipt"]);
  });

  it("records a campaign that is already open with exactly the offering's parameters, without sending a transaction", async () => {
    const c = chain({ reads: [open] });
    const repo = repository();
    const { service: svc } = service(c, repo);

    const activation = await svc.activate(request);

    expect(activation).toEqual({ kind: "recorded_open", adopted: true });
    expect(c.openCampaign).not.toHaveBeenCalled();
    expect(repo.observations).toHaveLength(1);
    expect(repo.observations[0]).toMatchObject({ state: "open", openTxHash: null, observedAt: NOW });
  });

  it("answers a job replay for an open campaign as ready, without a transaction", async () => {
    const c = chain({ reads: [open] });

    const result = await service(c, repository(recordedRow())).service.execute(payload);

    expect(c.openCampaign).not.toHaveBeenCalled();
    expect(result).toEqual({ pivId: "piv_1", tokenId: "7", transactionHash: null, ready: true });
  });

  it.each([
    ["target", [TARGET + 1n, 0n, BigInt(DEADLINE_UNIX), TREASURY, 1, false] as CampaignOf, "target_amount"],
    ["deadline", [TARGET, 0n, BigInt(DEADLINE_UNIX + 86_400), TREASURY, 1, false] as CampaignOf, "deadline"],
    ["treasury", [TARGET, 0n, BigInt(DEADLINE_UNIX), OTHER_TREASURY, 1, false] as CampaignOf, "treasury"],
  ])(
    "refuses a pre-existing Open campaign whose %s differs: nothing is recorded, an error with a stable event name is logged, and the job fails",
    async (_name, campaign, parameter) => {
      const c = chain({ reads: [campaign] });
      const repo = repository();
      const { service: svc, entries } = service(c, repo);

      const failure = await svc.execute(payload).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(IpoEscrowCampaignMismatchError);
      expect((failure as IpoEscrowCampaignMismatchError).differences.map((d) => d.parameter)).toEqual([parameter]);
      expect((failure as Error).message).toContain(`${parameter} expected`);
      expect(c.openCampaign).not.toHaveBeenCalled();
      expect(repo.observations).toEqual([]);
      expect(repo.refreshes).toEqual([]);
      const logged = entries.filter((entry) => entry.level === "error");
      expect(logged).toHaveLength(1);
      expect(logged[0]?.fields).toMatchObject({
        event: IPO_ESCROW_CAMPAIGN_ALERT_EVENTS.mismatch,
        severity: "error",
        piv_id: "piv_1",
        token_id: "7",
      });
      expect(IPO_ESCROW_CAMPAIGN_ALERT_EVENTS.mismatch).toBe("settlement.ipo_escrow_campaign_mismatch");
    },
  );

  it("lists every differing parameter, not just the first", async () => {
    const c = chain({ reads: [[TARGET + 1n, 0n, BigInt(DEADLINE_UNIX + 1), OTHER_TREASURY, 1, false]] });

    const activation = await service(c, repository()).service.activate(request);

    expect(activation).toMatchObject({ kind: "refused_mismatch" });
    expect(activation.kind === "refused_mismatch" && activation.differences.map((d) => d.parameter)).toEqual([
      "target_amount",
      "deadline",
      "treasury",
    ]);
  });

  it("refuses a recorded campaign of another escrow contract (a redeploy) without sending anything, whatever the new contract shows", async () => {
    const c = chain({ reads: [notOpened] });
    const repo = repository(recordedRow({ escrowContractAddress: OTHER_ESCROW.toLowerCase() }));
    const { service: svc, entries } = service(c, repo);

    const activation = await svc.activate(request);

    expect(activation).toEqual({
      kind: "refused_mismatch",
      differences: [{ parameter: "escrow_address", expected: ESCROW, actual: OTHER_ESCROW.toLowerCase() }],
    });
    expect(c.openCampaign).not.toHaveBeenCalled();
    expect(repo.observations).toEqual([]);
    expect(entries.filter((entry) => entry.fields.event === IPO_ESCROW_CAMPAIGN_ALERT_EVENTS.mismatch)).toHaveLength(1);
  });

  it("says, in the alert it logs for a row of another escrow contract, that the stored observation is the problem and not a campaign on-chain", async () => {
    const stale = service(chain({ reads: [notOpened] }), repository(recordedRow({ escrowContractAddress: OTHER_ESCROW.toLowerCase() })));
    const onChain = service(chain({ reads: [[TARGET, 0n, BigInt(DEADLINE_UNIX), OTHER_TREASURY, 1, false]] }), repository());

    await stale.service.activate(request);
    await onChain.service.activate(request);

    const [staleAlert] = stale.entries.filter((entry) => entry.fields.event === IPO_ESCROW_CAMPAIGN_ALERT_EVENTS.mismatch);
    const [onChainAlert] = onChain.entries.filter((entry) => entry.fields.event === IPO_ESCROW_CAMPAIGN_ALERT_EVENTS.mismatch);
    expect(staleAlert?.message).toContain("recorded for another escrow contract");
    expect(staleAlert?.message).toContain("the contract was redeployed");
    expect(onChainAlert?.message).toContain("exists on-chain with other parameters");
    expect(onChainAlert?.message).not.toContain("redeployed");
  });

  it.each([
    ["Successful", 2],
    ["Failed", 3],
  ] as const)(
    "does not record a campaign already %s as ready: it takes no contributions, and without a row there is nothing to move",
    async (_name, state) => {
      const c = chain({ reads: [[TARGET, 1n, BigInt(DEADLINE_UNIX), TREASURY, state, false]] });
      const repo = repository();

      const result = await service(c, repo).service.execute(payload);

      expect(c.openCampaign).not.toHaveBeenCalled();
      expect(result.ready).toBe(false);
      expect(repo.observations).toEqual([]);
      expect(repo.refreshes).toEqual([]);
    },
  );

  it.each([
    ["Successful", 2, "successful"],
    ["Failed", 3, "failed"],
  ] as const)(
    "moves an existing observation to %s when the chain shows it resolved, so the offering stops being ready",
    async (_name, state, expected) => {
      const c = chain({ reads: [[TARGET, 1n, BigInt(DEADLINE_UNIX), TREASURY, state, false]] });
      const repo = repository(recordedRow());

      const activation = await service(c, repo).service.activate(request);

      expect(activation).toEqual({ kind: "resolved", state: expected, recorded: true });
      expect(repo.refreshes).toEqual([
        { pivId: "piv_1", escrowContractAddress: ESCROW, state: expected, observedAt: NOW },
      ]);
      expect(repo.row?.observedState).toBe(expected);
    },
  );

  it("opens a campaign again when a row says it was opened but the chain no longer shows it (a dropped open), and overwrites the row from the new read", async () => {
    const c = chain({ reads: [notOpened, open] });
    const repo = repository(recordedRow({ openTxHash: `0x${"cd".repeat(32)}` }));

    const activation = await service(c, repo).service.activate(request);

    expect(activation).toEqual({ kind: "opened", transactionHash: TX_HASH });
    expect(repo.observations).toHaveLength(1);
    expect(repo.observations[0]).toMatchObject({ state: "open", openTxHash: TX_HASH });
  });

  it("records nothing when the open transaction reverts", async () => {
    const c = chain({ reads: [notOpened], receiptStatus: "reverted" });
    const repo = repository();

    await expect(service(c, repo).service.execute(payload)).rejects.toThrow(/reverted/);
    expect(repo.observations).toEqual([]);
  });

  it("fails rather than record readiness when the chain does not show the campaign open after the send", async () => {
    const c = chain({ reads: [notOpened, notOpened] });
    const repo = repository();

    await expect(service(c, repo).service.execute(payload)).rejects.toThrow(/does not show the campaign open/);
    expect(repo.observations).toEqual([]);
  });

  it("refuses, and records nothing, when the campaign shows other parameters than the offering's right after the send", async () => {
    const c = chain({ reads: [notOpened, [TARGET + 1n, 0n, BigInt(DEADLINE_UNIX), TREASURY, 1, false]] });
    const repo = repository();
    const { service: svc, entries } = service(c, repo);

    const activation = await svc.activate(request);

    expect(activation).toMatchObject({ kind: "refused_mismatch" });
    expect(repo.observations).toEqual([]);
    expect(entries.some((entry) => entry.fields.event === IPO_ESCROW_CAMPAIGN_ALERT_EVENTS.mismatch)).toBe(true);
  });

  it("inspects without writing: it reads the chain and the stored row and sends and records nothing", async () => {
    const c = chain({ reads: [notOpened] });
    const repo = repository();

    const inspection = await service(c, repo).service.inspect(request);

    expect(inspection.action).toEqual({ kind: "open" });
    expect(inspection.observedAt).toEqual(NOW);
    expect(c.openCampaign).not.toHaveBeenCalled();
    expect(repo.observations).toEqual([]);
    expect(repo.refreshes).toEqual([]);
  });

  it("rejects an unknown campaign state code instead of guessing", async () => {
    const c = chain({ reads: [[TARGET, 0n, BigInt(DEADLINE_UNIX), TREASURY, 9, false]] });

    await expect(service(c, repository()).service.activate(request)).rejects.toThrow(/unknown campaign state 9/);
  });
});
