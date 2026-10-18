import { describe, expect, it } from "vitest";

import {
  ESCROW_MINT_IN_FLIGHT_GRACE_MS,
  FinalizeIpoEscrowCampaignsService,
} from "../src/modules/settlement/application/finalize-ipo-escrow-campaigns.service.js";
import {
  CAMPAIGN_STATE_OPEN,
  FakeEscrowChain,
  InMemorySettlementRepository,
  makeCapturingLogger,
  successfulCampaign,
  type FakeCampaign,
} from "./support/escrow-mint-fakes.js";

const T0 = new Date("2026-10-18T12:00:00.000Z");
const TRACE_ID = "req_test";

interface HarnessOptions {
  campaigns: Map<string, FakeCampaign>;
  contributions: Map<string, Map<string, bigint>>;
  contributors: Map<string, string[]>;
  candidates: Array<{ pivId: string; tokenId: string }>;
  wallets: Record<string, string>;
  legacyPositions?: Array<{ pivId: string; accountId: string }>;
}

// The whole system under test, with one clock the test can advance and one
// timeline both fakes append to.
function harness(options: HarnessOptions) {
  const timeline: string[] = [];
  const chain = new FakeEscrowChain(options.campaigns, options.contributions, options.contributors, timeline);
  const repository = new InMemorySettlementRepository(
    options.candidates,
    options.wallets,
    timeline,
    options.legacyPositions,
  );
  const { logger, entries } = makeCapturingLogger();
  let now = T0;
  const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, logger, () => now);
  return {
    chain,
    repository,
    entries,
    timeline,
    service,
    run: () => service.execute(TRACE_ID),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

// One PIV (token 1) with one contributor of 100 base units, Successful, not swept.
function singleContributor() {
  return harness({
    ...successfulCampaign({ tokenId: "1", contributions: { "0xInvestorA": 100n } }),
    candidates: [{ pivId: "piv_1", tokenId: "1" }],
    wallets: { "0xInvestorA": "account_a" },
  });
}

describe("FinalizeIpoEscrowCampaignsService", () => {
  it("finalizes a fully-funded campaign as Successful, mints every contributor, and sweeps to treasury", async () => {
    const campaigns = new Map([
      [
        "1",
        {
          targetAmount: 300_000_000_000n,
          totalRaised: 300_000_000_000n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_OPEN,
          swept: false,
        },
      ],
    ]);
    const contributions = new Map([
      ["1", new Map([["0xInvestorA", 200_000_000_000n], ["0xInvestorB", 100_000_000_000n]])],
    ]);
    const contributors = new Map([["1", ["0xInvestorA", "0xInvestorB"]]]);
    const h = harness({
      campaigns,
      contributions,
      contributors,
      candidates: [{ pivId: "piv_1", tokenId: "1" }],
      wallets: { "0xInvestorA": "account_a", "0xInvestorB": "account_b" },
    });

    const summary = await h.run();

    expect(summary).toMatchObject({
      pivsChecked: 1,
      campaignsFinalized: 1,
      campaignsSuccessful: 1,
      campaignsFailed: 0,
      positionsMinted: 2,
      mintsReconciled: 0,
      errors: [],
    });
    expect(h.chain.ipoEscrow.write.finalize).toHaveBeenCalledTimes(1);
    expect(h.chain.property.write.authorizeHolder).toHaveBeenCalledTimes(2);
    expect(h.chain.property.write.mint).toHaveBeenCalledTimes(2);
    expect(h.chain.ipoEscrow.write.withdrawRaised).toHaveBeenCalledTimes(1);
    expect(campaigns.get("1")!.swept).toBe(true);

    expect(h.repository.recordedPositions).toHaveLength(2);
    const positionA = h.repository.recordedPositions.find((p) => p.accountId === "account_a")!;
    expect(positionA.unitCount).toBe("200000.000000");
    expect(positionA.costBasisEur).toBe("200000.000000");
    // Each position is linked to a distinct, recorded intent and carries its mint's real hash.
    const intents = [...h.repository.intents.values()];
    expect(intents.map((i) => i.status)).toEqual(["recorded", "recorded"]);
    expect(h.repository.recordedPositions.map((p) => p.chainTxHash).sort()).toEqual(
      h.chain.mints.map((m) => m.hash).sort(),
    );
  });

  it("finalizes an underfunded campaign as Failed and does not mint or sweep", async () => {
    const campaigns = new Map([
      [
        "2",
        {
          targetAmount: 300_000_000_000n,
          totalRaised: 100_000_000_000n,
          deadline: 1n,
          treasury: "0xTREASURY",
          state: CAMPAIGN_STATE_OPEN,
          swept: false,
        },
      ],
    ]);
    const h = harness({
      campaigns,
      contributions: new Map(),
      contributors: new Map([["2", ["0xInvestorA"]]]),
      candidates: [{ pivId: "piv_2", tokenId: "2" }],
      wallets: {},
    });

    const summary = await h.run();

    expect(summary).toMatchObject({
      campaignsFinalized: 1,
      campaignsSuccessful: 0,
      campaignsFailed: 1,
      positionsMinted: 0,
    });
    expect(h.chain.property.write.mint).not.toHaveBeenCalled();
    expect(h.chain.ipoEscrow.write.withdrawRaised).not.toHaveBeenCalled();
  });

  it("skips an already-swept campaign entirely", async () => {
    const h = harness({
      ...successfulCampaign({ tokenId: "3", contributions: {}, swept: true }),
      candidates: [{ pivId: "piv_3", tokenId: "3" }],
      wallets: {},
    });

    const summary = await h.run();

    expect(summary).toMatchObject({ campaignsFinalized: 0, campaignsSuccessful: 0, campaignsFailed: 0 });
    expect(h.chain.ipoEscrow.write.finalize).not.toHaveBeenCalled();
  });

  it("does not re-call finalize on a campaign that's already Successful but not yet swept (resumed after an interruption)", async () => {
    const h = harness({
      ...successfulCampaign({ tokenId: "4", contributions: { "0xInvestorA": 100n } }),
      candidates: [{ pivId: "piv_4", tokenId: "4" }],
      wallets: { "0xInvestorA": "account_a" },
    });

    const summary = await h.run();

    expect(h.chain.ipoEscrow.write.finalize).not.toHaveBeenCalled();
    expect(summary.campaignsFinalized).toBe(0);
    expect(summary.campaignsSuccessful).toBe(1);
    expect(summary.positionsMinted).toBe(1);
    expect(h.chain.ipoEscrow.write.withdrawRaised).toHaveBeenCalledTimes(1);
  });

  it("skips a contributor who already has a position, without re-minting, while still minting the rest", async () => {
    const h = harness({
      ...successfulCampaign({ tokenId: "5", contributions: { "0xInvestorA": 100n, "0xInvestorB": 100n } }),
      candidates: [{ pivId: "piv_5", tokenId: "5" }],
      wallets: { "0xInvestorA": "account_a", "0xInvestorB": "account_b" },
      legacyPositions: [{ pivId: "piv_5", accountId: "account_a" }], // minted and recorded on a prior run
    });

    const summary = await h.run();

    expect(summary.positionsMinted).toBe(1);
    expect(h.chain.property.write.mint).toHaveBeenCalledTimes(1);
    expect(h.repository.recordedPositions).toHaveLength(1);
    expect(h.repository.recordedPositions[0]?.accountId).toBe("account_b");
  });

  it("records a per-campaign error without aborting other candidates in the same run", async () => {
    const six = successfulCampaign({ tokenId: "6", contributions: { "0xUnregistered": 100n } });
    const seven = successfulCampaign({ tokenId: "7", contributions: { "0xInvestorA": 100n } });
    const h = harness({
      campaigns: new Map([...six.campaigns, ...seven.campaigns]),
      contributions: new Map([...six.contributions, ...seven.contributions]),
      contributors: new Map([...six.contributors, ...seven.contributors]),
      candidates: [
        { pivId: "piv_6", tokenId: "6" },
        { pivId: "piv_7", tokenId: "7" },
      ],
      wallets: { "0xInvestorA": "account_a" }, // 0xUnregistered deliberately has no account
    });

    const summary = await h.run();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain("piv_id=piv_6");
    expect(summary.errors[0]).toContain("0xUnregistered");
    // Campaign 7 (unrelated) still fully processed despite campaign 6's failure.
    expect(summary.positionsMinted).toBe(1);
    expect(six.campaigns.get("6")!.swept).toBe(false);
    expect(seven.campaigns.get("7")!.swept).toBe(true);
  });

  it("logs each failed campaign at error level with its piv_id, token_id and trace_id", async () => {
    const h = harness({
      ...successfulCampaign({ tokenId: "6", contributions: { "0xUnregistered": 100n } }),
      candidates: [{ pivId: "piv_6", tokenId: "6" }],
      wallets: {},
    });

    await h.run();

    const errors = h.entries.filter((entry) => entry.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ trace_id: TRACE_ID, piv_id: "piv_6", token_id: "6" });
    expect((errors[0]?.fields["err"] as Error).message).toContain("0xUnregistered");
  });

  describe("recording the intent and the transaction hash", () => {
    it("writes the intent before the mint is sent and the hash before its receipt is awaited", async () => {
      const h = singleContributor();
      let intentWhenMintWasSent: Array<{ status: string; hash: string | null }> = [];
      h.chain.onMint = () => {
        intentWhenMintWasSent = [...h.repository.intents.values()].map((i) => ({
          status: i.status,
          hash: i.mintTxHash,
        }));
      };

      await h.run();

      // At the moment write.mint ran, the durable intent already existed and no hash was known yet.
      expect(intentWhenMintWasSent).toEqual([{ status: "sending", hash: null }]);

      const mintHash = h.chain.mints[0]!.hash;
      const order = h.timeline.filter(
        (entry) => entry.startsWith("repo:") || entry === "chain:mint" || entry === `chain:waitForReceipt(${mintHash})`,
      );
      expect(order).toEqual([
        "repo:createEscrowMintIntent",
        "chain:mint",
        "repo:recordEscrowMintSent",
        `chain:waitForReceipt(${mintHash})`,
        "repo:recordEscrowMintedPosition",
      ]);
    });

    it("records the position and the intent's final status together, with the mint's own hash", async () => {
      const h = singleContributor();

      await h.run();

      const [intent] = [...h.repository.intents.values()];
      const [position] = h.repository.positions;
      expect(intent).toMatchObject({ status: "recorded", mintTxHash: h.chain.mints[0]!.hash, attempt: 1 });
      expect(position?.input).toMatchObject({
        escrowMintIntentId: intent!.id,
        chainTxHash: h.chain.mints[0]!.hash,
      });
    });
  });

  describe("crash windows", () => {
    it("before anything is written: nothing exists on either side, and the next run mints exactly once", async () => {
      const h = singleContributor();
      h.repository.failNext("createEscrowMintIntent", "before");

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(0);
      expect(h.repository.intents.size).toBe(0);

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.repository.recordedPositions).toHaveLength(1);
    });

    it("after the intent is written but before the mint is sent: waits out the in-flight window, then mints exactly once", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("reject"); // the call never reaches the node

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(0);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "sending", mintTxHash: null });

      // Soon after: the attempt left no hash, so it may have reached the node. Nothing is sent.
      h.advance(60_000);
      const tooSoon = await h.run();
      expect(tooSoon.errors).toHaveLength(1);
      expect(tooSoon.errors[0]).toContain("may still be in flight");
      expect(tooSoon.errors[0]).toContain("0xInvestorA");
      expect(h.chain.mints).toHaveLength(0);
      expect(h.repository.recordedPositions).toHaveLength(0);

      // Once the window has passed with nothing on-chain, one mint is sent and recorded.
      h.advance(ESCROW_MINT_IN_FLIGHT_GRACE_MS);
      const later = await h.run();
      expect(later.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "recorded", attempt: 2 });
    });

    it("after the mint was sent but the call never returned its hash: records the mint that is on-chain instead of sending another", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("mine-then-reject"); // accepted and mined; the caller only sees an RPC timeout

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(1);
      // The log search window opens a little before the head the attempt started from (1000 - 32).
      expect([...h.repository.intents.values()][0]).toMatchObject({
        status: "sending",
        mintTxHash: null,
        searchFromBlock: 968n,
      });
      expect(h.repository.recordedPositions).toHaveLength(0);

      // No waiting needed: the chain shows the mint, so there is nothing to wait out.
      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(second).toMatchObject({ positionsMinted: 1, mintsReconciled: 1 });
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.repository.recordedPositions[0]).toMatchObject({ chainTxHash: h.chain.mints[0]!.hash });
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "recorded" });
      expect(h.entries.some((e) => e.level === "warn" && e.fields["tx_hash"] === h.chain.mints[0]!.hash)).toBe(true);
    });

    it("after the mint was sent but writing its hash failed: reports the hash and records the existing mint on the next run", async () => {
      const h = singleContributor();
      h.repository.failNext("recordEscrowMintSent", "before");

      const first = await h.run();

      const mintHash = h.chain.mints[0]!.hash;
      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toContain(mintHash);
      expect(first.errors[0]).toContain("could not be recorded");
      const loggedFailure = h.entries.find((e) => e.level === "error");
      expect((loggedFailure?.fields["err"] as Error).message).toContain(mintHash);

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect(h.repository.recordedPositions[0]?.chainTxHash).toBe(mintHash);
    });

    it("refuses to guess when the mint is on-chain but its transaction cannot be found in the logs", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("mine-then-reject");
      await h.run();
      h.chain.transferLogs.length = 0; // the log lookup comes back empty

      const second = await h.run();

      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]).toContain("could not be found in the chain logs");
      expect(second.errors[0]).toContain("0xInvestorA");
      expect(h.chain.mints).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("after the hash was recorded but before the position was: records the position from the recorded hash without minting or authorizing again", async () => {
      const h = singleContributor();
      h.repository.failNext("recordEscrowMintedPosition", "before");

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect([...h.repository.intents.values()][0]).toMatchObject({
        status: "mint_sent",
        mintTxHash: h.chain.mints[0]!.hash,
      });
      expect(h.repository.recordedPositions).toHaveLength(0);

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(second).toMatchObject({ positionsMinted: 1, mintsReconciled: 1 });
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.property.write.authorizeHolder).toHaveBeenCalledTimes(1);
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect(h.repository.recordedPositions[0]?.chainTxHash).toBe(h.chain.mints[0]!.hash);
    });

    it("after the position was committed but before the caller learned of it: the next run touches nothing on-chain for that contributor", async () => {
      const h = singleContributor();
      h.repository.failNext("recordEscrowMintedPosition", "after");

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(1);

      const mintsBefore = h.chain.mints.length;
      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(second.positionsMinted).toBe(0);
      expect(h.chain.mints).toHaveLength(mintsBefore);
      expect(h.chain.property.write.authorizeHolder).toHaveBeenCalledTimes(1);
      expect(h.repository.recordedPositions).toHaveLength(1);
      // The interrupted run never reached the sweep; this one completes it.
      expect(h.chain.ipoEscrow.write.withdrawRaised).toHaveBeenCalledTimes(1);
    });

    it("after every position was recorded but before the sweep: the next run sweeps without minting anything", async () => {
      const h = harness({
        ...successfulCampaign({ tokenId: "1", contributions: { "0xInvestorA": 100n, "0xInvestorB": 50n } }),
        candidates: [{ pivId: "piv_1", tokenId: "1" }],
        wallets: { "0xInvestorA": "account_a", "0xInvestorB": "account_b" },
      });
      h.chain.failWithdrawRaisedOnce = true;

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(2);
      expect(h.repository.recordedPositions).toHaveLength(2);

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(second.positionsMinted).toBe(0);
      expect(h.chain.mints).toHaveLength(2);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.chain.balanceOf("0xInvestorB", 1n)).toBe(50n);
      expect(h.repository.recordedPositions).toHaveLength(2);
      expect(h.chain.ipoEscrow.write.withdrawRaised).toHaveBeenCalledTimes(2);
    });

    it("resumes a partly-processed contributor list: finished contributors are untouched, the interrupted one is completed once", async () => {
      const h = harness({
        ...successfulCampaign({
          tokenId: "1",
          contributions: { "0xInvestorA": 100n, "0xInvestorB": 50n, "0xInvestorC": 25n },
        }),
        candidates: [{ pivId: "piv_1", tokenId: "1" }],
        wallets: { "0xInvestorA": "account_a", "0xInvestorB": "account_b", "0xInvestorC": "account_c" },
      });
      // A completes; B's mint is accepted but the call dies; C is never reached.
      h.chain.mintModes.push("mine", "mine-then-reject");

      const first = await h.run();
      expect(first.errors).toHaveLength(1);
      expect(h.chain.mints.map((m) => m.to)).toEqual(["0xInvestorA", "0xInvestorB"]);

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(h.chain.mints.map((m) => m.to)).toEqual(["0xInvestorA", "0xInvestorB", "0xInvestorC"]);
      expect(h.repository.recordedPositions.map((p) => p.accountId).sort()).toEqual([
        "account_a",
        "account_b",
        "account_c",
      ]);
      expect(h.chain.balanceOf("0xInvestorB", 1n)).toBe(50n);
    });
  });

  describe("reconciling against the chain on retry", () => {
    it("does not send another mint while a recorded transaction has no receipt yet, and records it once it lands", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("pending");

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "mint_sent" });

      h.advance(10 * ESCROW_MINT_IN_FLIGHT_GRACE_MS); // age alone must not make a recorded hash re-sendable
      const stillPending = await h.run();

      expect(stillPending.errors).toHaveLength(1);
      expect(stillPending.errors[0]).toContain("has no receipt yet");
      expect(stillPending.errors[0]).toContain(h.chain.mints[0]!.hash);
      expect(h.chain.mints).toHaveLength(1);

      h.chain.mineNextPending();
      const landed = await h.run();

      expect(landed.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.repository.recordedPositions).toHaveLength(1);
    });

    it("sends a replacement mint only after a recorded transaction is confirmed reverted and the wallet holds nothing", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("revert");

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toContain("mint transaction reverted");
      const revertedHash = h.chain.mints[0]!.hash;
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(0n);

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(2);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n); // minted once, not twice
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect(h.repository.recordedPositions[0]?.chainTxHash).toBe(h.chain.mints[1]!.hash);
      expect(h.entries.some((e) => e.level === "warn" && e.fields["tx_hash"] === revertedHash)).toBe(true);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "recorded", attempt: 2 });
    });

    it("records a mint that is on-chain with no database record at all instead of minting it again", async () => {
      // What the job before intents existed leaves behind when it dies after the mint, before the position.
      const h = singleContributor();
      const orphanHash = h.chain.seedUnrecordedMint("0xInvestorA", 1n, 100n);

      const summary = await h.run();

      expect(summary.errors).toEqual([]);
      expect(summary).toMatchObject({ positionsMinted: 1, mintsReconciled: 1 });
      expect(h.chain.mints).toHaveLength(1); // only the orphan; nothing new was sent
      expect(h.chain.property.write.mint).not.toHaveBeenCalled();
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect(h.repository.recordedPositions[0]?.chainTxHash).toBe(orphanHash);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "recorded", mintTxHash: orphanHash });
    });

    it("refuses to mint when the wallet holds a different amount than its contribution", async () => {
      const h = singleContributor();
      h.chain.balances.set("0xinvestora:1", 40n);

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("0xInvestorA");
      expect(summary.errors[0]).toContain("holds 40");
      expect(summary.errors[0]).toContain("no completed mint is recorded for it");
      expect(summary.errors[0]).toContain("manual reconciliation");
      expect(h.chain.mints).toHaveLength(0);
      expect(h.chain.property.write.authorizeHolder).not.toHaveBeenCalled();
      expect(h.repository.recordedPositions).toHaveLength(0);
      expect(h.repository.intents.size).toBe(0);
    });

    it("refuses to mint a second time when the wallet already holds double its contribution", async () => {
      const h = singleContributor();
      h.chain.balances.set("0xinvestora:1", 200n);

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("holds 200");
      expect(summary.errors[0]).toContain("no completed mint is recorded for it");
      expect(h.chain.mints).toHaveLength(0);
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("refuses to record a mint when the wallet holds more than its contribution, even though one mint log matches", async () => {
      const h = singleContributor();
      h.chain.seedUnrecordedMint("0xInvestorA", 1n, 100n);
      h.chain.balances.set("0xinvestora:1", 140n); // 40 more arrived some other way

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("holds 140");
      expect(summary.errors[0]).toContain("no completed mint is recorded for it");
      expect(h.repository.recordedPositions).toHaveLength(0);
      expect(h.repository.intents.size).toBe(0);
    });

    it("looks for the mint's transaction only from the block the attempt started at", async () => {
      const h = singleContributor();
      h.chain.seedUnrecordedMint("0xInvestorA", 1n, 100n); // lands in block 1001
      h.repository.seedIntent({
        pivId: "piv_1",
        accountId: "account_a",
        walletAddress: "0xInvestorA",
        searchFromBlock: 1_500n, // the attempt began after that block, so that mint cannot be this attempt's
      });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("could not be found in the chain logs");
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("does not take a mint log for a different amount as the mint of this contribution", async () => {
      const h = singleContributor();
      h.chain.seedUnrecordedMint("0xInvestorA", 1n, 70n);
      h.chain.balances.set("0xinvestora:1", 100n); // the other 30 arrived some other way

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("could not be found in the chain logs");
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("does not take a mint log for a different token as the mint of this one", async () => {
      const h = singleContributor();
      h.chain.seedUnrecordedMint("0xInvestorA", 2n, 100n);
      h.chain.balances.set("0xinvestora:1", 100n);

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("could not be found in the chain logs");
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("does not send a replacement for a reverted transaction when the wallet nevertheless holds tokens", async () => {
      const h = singleContributor();
      h.chain.transactions.set("0xreverted", { status: "reverted" });
      h.repository.seedIntent({
        pivId: "piv_1",
        accountId: "account_a",
        walletAddress: "0xInvestorA",
        status: "mint_sent",
        mintTxHash: "0xreverted",
      });
      h.chain.balances.set("0xinvestora:1", 100n);

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("its recorded mint transaction 0xreverted reverted");
      expect(h.chain.property.write.mint).not.toHaveBeenCalled();
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("does not send when the intent's record contradicts the chain", async () => {
      const h = singleContributor();
      h.repository.seedIntent({
        pivId: "piv_1",
        accountId: "account_a",
        walletAddress: "0xSomeoneElse",
        tokenId: "1",
        mintAmount: 100n,
      });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("does not match the contribution now on-chain");
      expect(h.chain.mints).toHaveLength(0);
    });

    it("does not mint when an intent is marked recorded but its position is missing", async () => {
      const h = singleContributor();
      h.repository.seedIntent({ pivId: "piv_1", accountId: "account_a", status: "recorded", mintTxHash: "0xold" });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("is recorded but no position exists");
      expect(h.chain.mints).toHaveLength(0);
    });

    it("does not mint a zero contribution", async () => {
      const h = harness({
        ...successfulCampaign({ tokenId: "1", contributions: { "0xInvestorA": 0n } }),
        candidates: [{ pivId: "piv_1", tokenId: "1" }],
        wallets: { "0xInvestorA": "account_a" },
      });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("no contribution to mint");
      expect(h.chain.mints).toHaveLength(0);
      expect(h.repository.intents.size).toBe(0);
    });
  });

  describe("overlapping runs", () => {
    it("does not send when another run claimed the contributor between this run's read and its claim", async () => {
      const h = singleContributor();
      // The other run's claim lands after this run found no intent but before it writes its own.
      h.repository.interleaveBefore("createEscrowMintIntent", () => {
        h.repository.seedIntent({
          pivId: "piv_1",
          accountId: "account_a",
          walletAddress: "0xInvestorA",
          attemptedAt: T0,
        });
      });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("another run already claimed the mint");
      expect(h.chain.mints).toHaveLength(0);
    });

    it("does not send when another run restarted the attempt first", async () => {
      const h = singleContributor();
      const seeded = h.repository.seedIntent({
        pivId: "piv_1",
        accountId: "account_a",
        walletAddress: "0xInvestorA",
        attemptedAt: new Date(T0.getTime() - 2 * ESCROW_MINT_IN_FLIGHT_GRACE_MS),
      });
      // Between this run reading attempt 1 and restarting it, another run moves to attempt 2.
      h.repository.interleaveBefore("restartEscrowMintAttempt", () => {
        seeded.attempt = 2;
        seeded.attemptedAt = T0;
      });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("another run already claimed the mint");
      expect(h.chain.mints).toHaveLength(0);
    });
  });

  describe("holder authorization", () => {
    it("does not pay for an authorizeHolder transaction when the holder is already authorized", async () => {
      const h = singleContributor();
      h.chain.authorizedHolders.add("0xinvestora:1");

      const summary = await h.run();

      expect(summary.errors).toEqual([]);
      expect(h.chain.property.write.authorizeHolder).not.toHaveBeenCalled();
      expect(h.chain.mints).toHaveLength(1);
    });

    it("stops before minting, and before writing an intent, when the authorizeHolder transaction reverted", async () => {
      const h = singleContributor();
      h.chain.authorizeReverts = true;

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("authorizeHolder transaction reverted");
      expect(h.chain.mints).toHaveLength(0);
      expect(h.repository.intents.size).toBe(0);
    });
  });
});
