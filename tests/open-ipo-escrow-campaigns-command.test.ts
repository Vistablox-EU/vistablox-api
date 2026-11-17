import { describe, expect, it, vi } from "vitest";

import { parseOpenIpoEscrowCampaignsArguments } from "../src/cli/open-ipo-escrow-campaigns-arguments.js";
import { settlementChainConfig } from "../src/infrastructure/blockchain/settlement-bundle.js";
import { OpenIpoEscrowCampaignService } from "../src/modules/settlement/application/open-ipo-escrow-campaign.service.js";
import {
  IPO_ESCROW_ACTIVATION_ALERT_EVENTS,
  OpenIpoEscrowCampaignsCommandService,
  renderIpoEscrowActivationReport,
  type IpoEscrowActivationMode,
} from "../src/modules/settlement/application/open-ipo-escrow-campaigns-command.service.js";
import type {
  IpoEscrowCampaignRecord,
  OfferingForIpoEscrowActivation,
  RecordIpoEscrowCampaignObservationInput,
  RefreshIpoEscrowCampaignStateInput,
} from "../src/modules/settlement/repository/settlement.repository.js";
import { makeCapturingLogger } from "./support/escrow-mint-fakes.js";
import { InProcessOperatorKeyLock } from "./support/operator-key-lock-fakes.js";

const ESCROW = "0x00000000000000000000000000000000000E5c20";
const TREASURY = "0x000000000000000000000000000000000000Ba5e";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const IPO_END_AT = new Date("2026-11-01T12:00:30.500Z");
const DEADLINE = BigInt(Math.floor(IPO_END_AT.getTime() / 1000));
const TARGET = 250_000_500_000n; // 250000.50 EUR in EURC base units

type ChainCampaign = [bigint, bigint, bigint, string, number, boolean];
const NOT_OPENED: ChainCampaign = [0n, 0n, 0n, "0x0000000000000000000000000000000000000000", 0, false];
const openWith = (overrides: Partial<{ target: bigint; deadline: bigint; treasury: string; state: number }> = {}): ChainCampaign => [
  overrides.target ?? TARGET,
  0n,
  overrides.deadline ?? DEADLINE,
  overrides.treasury ?? TREASURY,
  overrides.state ?? 1,
  false,
];

function offering(n: number): OfferingForIpoEscrowActivation {
  return { pivId: `piv_${n}`, tokenId: String(n), targetRaiseEur: "250000.50", ipoEndAt: IPO_END_AT };
}

// A chain with one campaign per token id. openCampaign changes the campaign as the
// contract would, unless the test says that token's transaction fails.
function harness(options: {
  offerings: OfferingForIpoEscrowActivation[];
  campaigns: Record<string, ChainCampaign>;
  rows?: Record<string, IpoEscrowCampaignRecord>;
  failOpenFor?: string[];
}) {
  const campaigns = new Map(Object.entries(options.campaigns));
  const rows = new Map(Object.entries(options.rows ?? {}));
  const observations: RecordIpoEscrowCampaignObservationInput[] = [];
  const refreshes: RefreshIpoEscrowCampaignStateInput[] = [];
  const opened: bigint[] = [];
  let sending = 0;
  let maxSending = 0;
  const { logger, entries } = makeCapturingLogger();
  const timeline: string[] = [];

  const clients = {
    config: { ipoEscrowContractAddress: ESCROW, pivTreasuryAddress: TREASURY },
    ipoEscrow: {
      read: {
        campaignOf: vi.fn(async ([tokenId]: [bigint]) => campaigns.get(tokenId.toString()) ?? NOT_OPENED),
      },
      write: {
        openCampaign: vi.fn(async ([tokenId, target, deadline, treasury]: [bigint, bigint, bigint, string]) => {
          sending += 1;
          maxSending = Math.max(maxSending, sending);
          await Promise.resolve();
          sending -= 1;
          if (options.failOpenFor?.includes(tokenId.toString())) throw new Error("RPC error: connection refused");
          opened.push(tokenId);
          campaigns.set(tokenId.toString(), [target, 0n, deadline, treasury, 1, false]);
          return `0x${tokenId.toString(16).padStart(64, "0")}`;
        }),
      },
    },
    publicClient: { waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })) },
  };
  const repository = {
    findOfferingsForIpoEscrowActivation: vi.fn(async () => options.offerings),
    findIpoEscrowCampaign: vi.fn(async (pivId: string) => rows.get(pivId) ?? null),
    recordIpoEscrowCampaignObservation: vi.fn(async (input: RecordIpoEscrowCampaignObservationInput) => {
      observations.push(input);
    }),
    refreshIpoEscrowCampaignState: vi.fn(async (input: RefreshIpoEscrowCampaignStateInput) => {
      refreshes.push(input);
      return rows.has(input.pivId);
    }),
  };
  const lock = new InProcessOperatorKeyLock(timeline);
  const campaignService = new OpenIpoEscrowCampaignService(clients as never, repository, lock, logger, () => NOW);
  const command = new OpenIpoEscrowCampaignsCommandService(repository, campaignService, logger, () => NOW);
  return {
    command,
    run: (mode: IpoEscrowActivationMode) => command.run(mode),
    clients,
    repository,
    observations,
    refreshes,
    opened,
    entries,
    lock,
    maxSending: () => maxSending,
  };
}

const row = (pivId: string, overrides: Partial<IpoEscrowCampaignRecord> = {}): IpoEscrowCampaignRecord => ({
  pivId,
  tokenId: pivId.replace("piv_", ""),
  escrowContractAddress: ESCROW.toLowerCase(),
  targetAmount: TARGET,
  deadlineAt: new Date(Number(DEADLINE) * 1000),
  treasuryAddress: TREASURY.toLowerCase(),
  openTxHash: null,
  observedState: "open",
  observedAt: new Date("2026-09-30T12:00:00.000Z"),
  ...overrides,
});

describe("OpenIpoEscrowCampaignsCommandService", () => {
  describe("dry run", () => {
    it("reads and plans each offering and writes nothing: no transaction, no observation, no refresh", async () => {
      const h = harness({
        offerings: [offering(1), offering(2), offering(3), offering(4)],
        campaigns: {
          "1": NOT_OPENED,
          "2": openWith(),
          "3": openWith({ state: 2 }),
          "4": openWith({ target: 1n }),
        },
        rows: { piv_3: row("piv_3") },
      });

      const report = await h.run("dry_run");

      expect(report.outcomes.map((outcome) => [outcome.pivId, outcome.status])).toEqual([
        ["piv_1", "would_open"],
        ["piv_2", "would_record"],
        ["piv_3", "resolved_on_chain"],
        ["piv_4", "refused_mismatch"],
      ]);
      expect(h.clients.ipoEscrow.write.openCampaign).not.toHaveBeenCalled();
      expect(h.repository.recordIpoEscrowCampaignObservation).not.toHaveBeenCalled();
      expect(h.repository.refreshIpoEscrowCampaignState).not.toHaveBeenCalled();
      expect(h.lock.sections).toBe(0);
      // A dry run is not an alert: nothing is logged as an error for a mismatch it only reports.
      expect(h.entries).toEqual([]);
    });

    it("exits 0 when every offering would simply be opened or recorded", async () => {
      const h = harness({
        offerings: [offering(1), offering(2)],
        campaigns: { "1": NOT_OPENED, "2": openWith() },
      });

      expect((await h.run("dry_run")).exitCode).toBe(0);
    });

    it("exits 1 when an offering would be refused or is resolved on-chain, so a script can tell", async () => {
      const mismatch = harness({ offerings: [offering(1)], campaigns: { "1": openWith({ deadline: 5n }) } });
      const resolved = harness({ offerings: [offering(1)], campaigns: { "1": openWith({ state: 3 }) } });

      expect((await mismatch.run("dry_run")).exitCode).toBe(1);
      expect((await resolved.run("dry_run")).exitCode).toBe(1);
    });
  });

  describe("--confirm", () => {
    it("opens a campaign for an offering that has none, with the offering's target and deadline and the placeholder treasury, and records it", async () => {
      const h = harness({ offerings: [offering(1)], campaigns: { "1": NOT_OPENED } });

      const report = await h.run("confirm");

      expect(h.clients.ipoEscrow.write.openCampaign).toHaveBeenCalledWith([1n, TARGET, DEADLINE, TREASURY]);
      expect(report.outcomes).toEqual([
        { pivId: "piv_1", tokenId: "1", status: "opened", transactionHash: `0x${"1".padStart(64, "0")}` },
      ]);
      expect(h.observations).toHaveLength(1);
      expect(h.observations[0]).toMatchObject({
        pivId: "piv_1",
        tokenId: "1",
        targetAmount: TARGET,
        treasuryAddress: TREASURY,
        state: "open",
        observedAt: NOW,
      });
      expect(report.exitCode).toBe(0);
    });

    it("records, without sending, a campaign already open with the offering's own parameters, and is idempotent on a second run", async () => {
      const h = harness({ offerings: [offering(1)], campaigns: { "1": openWith() } });

      const first = await h.run("confirm");
      const second = await h.run("confirm");

      expect(first.outcomes[0]).toMatchObject({ status: "recorded", adopted: true });
      expect(second.outcomes[0]).toMatchObject({ status: "recorded" });
      expect(h.clients.ipoEscrow.write.openCampaign).not.toHaveBeenCalled();
      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
    });

    it("refuses a pre-existing campaign with other parameters: names the differences, records nothing, logs the stable event, exits 1", async () => {
      const h = harness({
        offerings: [offering(1)],
        campaigns: { "1": openWith({ target: 1n, treasury: "0x0000000000000000000000000000000000000001" }) },
      });

      const report = await h.run("confirm");

      expect(report.outcomes[0]).toMatchObject({ status: "refused_mismatch" });
      expect(report.outcomes[0]?.differences?.map((difference) => difference.parameter)).toEqual([
        "target_amount",
        "treasury",
      ]);
      expect(h.clients.ipoEscrow.write.openCampaign).not.toHaveBeenCalled();
      expect(h.observations).toEqual([]);
      expect(
        h.entries.filter((entry) => entry.fields.event === "settlement.ipo_escrow_campaign_mismatch"),
      ).toHaveLength(1);
      expect(report.exitCode).toBe(1);
    });

    it("moves the observation of a campaign found Successful or Failed, reports it as needing manual action, and exits 1", async () => {
      const h = harness({
        offerings: [offering(1), offering(2)],
        campaigns: { "1": openWith({ state: 2 }), "2": openWith({ state: 3 }) },
        rows: { piv_1: row("piv_1") },
      });

      const report = await h.run("confirm");

      expect(report.outcomes).toEqual([
        { pivId: "piv_1", tokenId: "1", status: "resolved_on_chain", chainState: "successful", observationUpdated: true },
        { pivId: "piv_2", tokenId: "2", status: "resolved_on_chain", chainState: "failed", observationUpdated: false },
      ]);
      expect(h.refreshes).toEqual([{ pivId: "piv_1", state: "successful", observedAt: NOW }]);
      expect(report.exitCode).toBe(1);
    });

    it("isolates a failing offering: it is reported and logged, the next offerings are still opened, the exit code is 1", async () => {
      const h = harness({
        offerings: [offering(1), offering(2), offering(3)],
        campaigns: { "1": NOT_OPENED, "2": NOT_OPENED, "3": NOT_OPENED },
        failOpenFor: ["2"],
      });

      const report = await h.run("confirm");

      expect(report.outcomes.map((outcome) => outcome.status)).toEqual(["opened", "failed", "opened"]);
      expect(report.outcomes[1]).toMatchObject({ pivId: "piv_2", error: "RPC error: connection refused" });
      expect(h.opened).toEqual([1n, 3n]);
      expect(h.observations.map((observation) => observation.pivId)).toEqual(["piv_1", "piv_3"]);
      expect(
        h.entries.filter((entry) => entry.fields.event === IPO_ESCROW_ACTIVATION_ALERT_EVENTS.failed),
      ).toHaveLength(1);
      expect(report.exitCode).toBe(1);
    });

    it("handles one offering at a time", async () => {
      const h = harness({
        offerings: [offering(1), offering(2), offering(3)],
        campaigns: { "1": NOT_OPENED, "2": NOT_OPENED, "3": NOT_OPENED },
      });

      await h.run("confirm");

      expect(h.maxSending()).toBe(1);
      expect(h.lock.maxConcurrent).toBe(1);
      expect(h.lock.sections).toBe(3);
    });

    it("has nothing to do, and exits 0, when no offering is open for reservations", async () => {
      const h = harness({ offerings: [], campaigns: {} });

      const report = await h.run("confirm");

      expect(report).toEqual({ mode: "confirm", offeringsChecked: 0, outcomes: [], exitCode: 0 });
    });
  });
});

describe("renderIpoEscrowActivationReport", () => {
  const header = { chainNetwork: "base-sepolia", escrowContractAddress: ESCROW, treasuryAddress: TREASURY };

  it("says in the header which chain, which escrow, and that the treasury is the single placeholder with the per-PIV treasury undecided", async () => {
    const h = harness({ offerings: [offering(1)], campaigns: { "1": NOT_OPENED } });

    const text = renderIpoEscrowActivationReport(header, await h.run("dry_run")).join("\n");

    expect(text).toContain("Dry run, nothing changed");
    expect(text).toContain("base-sepolia (testnet only until the AD-234 activation gate passes)");
    expect(text).toContain(ESCROW);
    expect(text).toContain(`${TREASURY}, the single PIV_TREASURY_ADDRESS placeholder for every campaign`);
    expect(text).toContain("C-008 question 3");
    expect(text).toContain("would open the campaign");
    expect(text).toContain("Re-run with --confirm to open them.");
  });

  it("marks what needs manual action, and does not offer --confirm after a confirmed run", async () => {
    const h = harness({
      offerings: [offering(1), offering(2)],
      campaigns: { "1": openWith({ deadline: 9n }), "2": NOT_OPENED },
    });

    const text = renderIpoEscrowActivationReport(header, await h.run("confirm")).join("\n");

    expect(text).toContain("Opening IPO escrow campaigns (confirmed run)");
    expect(text).toContain("NEEDS MANUAL ACTION: open on-chain with other parameters, not adopted (deadline expected");
    expect(text).toContain("1 offering(s) failed or need manual action");
    expect(text).not.toContain("Re-run with --confirm");
  });
});

describe("parseOpenIpoEscrowCampaignsArguments", () => {
  it("is a dry run by default", () => {
    expect(parseOpenIpoEscrowCampaignsArguments([])).toEqual({ ok: true, value: { mode: "dry_run" } });
  });

  it("confirms only with --confirm", () => {
    expect(parseOpenIpoEscrowCampaignsArguments(["--confirm"])).toEqual({ ok: true, value: { mode: "confirm" } });
  });

  it("shows help", () => {
    expect(parseOpenIpoEscrowCampaignsArguments(["--help"])).toEqual({ ok: true, value: { mode: "help" } });
  });

  it.each([["--yes"], ["extra"], ["--dead-letter-job-id", "x"]])("rejects %s as bad arguments", (...argv) => {
    expect(parseOpenIpoEscrowCampaignsArguments(argv)).toMatchObject({ ok: false });
  });
});

describe("settlementChainConfig", () => {
  const complete = {
    CHAIN_NETWORK: "base-sepolia",
    CHAIN_RPC_URL: "https://sepolia.base.org",
    CHAIN_OPERATOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    VISTABLOX_PROPERTY_CONTRACT_ADDRESS: `0x${"a".repeat(40)}`,
    VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS: `0x${"b".repeat(40)}`,
    EURC_TOKEN_ADDRESS: `0x${"c".repeat(40)}`,
    PIV_TREASURY_ADDRESS: `0x${"d".repeat(40)}`,
  };

  it("builds the whole bundle's configuration", () => {
    expect(settlementChainConfig(complete)).toEqual({
      network: "base-sepolia",
      rpcUrl: complete.CHAIN_RPC_URL,
      operatorPrivateKey: complete.CHAIN_OPERATOR_PRIVATE_KEY,
      propertyContractAddress: complete.VISTABLOX_PROPERTY_CONTRACT_ADDRESS,
      ipoEscrowContractAddress: complete.VISTABLOX_IPO_ESCROW_CONTRACT_ADDRESS,
      eurcTokenAddress: complete.EURC_TOKEN_ADDRESS,
      pivTreasuryAddress: complete.PIV_TREASURY_ADDRESS,
    });
  });

  it("is undefined while the bundle is dormant or incomplete", () => {
    expect(settlementChainConfig({})).toBeUndefined();
    expect(settlementChainConfig({ ...complete, PIV_TREASURY_ADDRESS: undefined })).toBeUndefined();
  });
});
