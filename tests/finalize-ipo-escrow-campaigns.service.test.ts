import { describe, expect, it } from "vitest";

import {
  ESCROW_MINT_IN_FLIGHT_GRACE_MS,
  FinalizeIpoEscrowCampaignsService,
  type EscrowMintNonceBlockTag,
} from "../src/modules/settlement/application/finalize-ipo-escrow-campaigns.service.js";
import {
  CAMPAIGN_STATE_OPEN,
  FakeEscrowChain,
  InMemorySettlementRepository,
  makeCapturingLogger,
  PROPERTY_CONTRACT,
  successfulCampaign,
  type FakeCampaign,
} from "./support/escrow-mint-fakes.js";
import { InProcessOperatorKeyLock } from "./support/operator-key-lock-fakes.js";

const T0 = new Date("2026-10-18T12:00:00.000Z");
const TRACE_ID = "req_test";

interface HarnessOptions {
  campaigns: Map<string, FakeCampaign>;
  contributions: Map<string, Map<string, bigint>>;
  contributors: Map<string, string[]>;
  candidates: Array<{ pivId: string; tokenId: string }>;
  wallets: Record<string, string>;
  legacyPositions?: Array<{ pivId: string; accountId: string }>;
  nonceBlockTag?: EscrowMintNonceBlockTag;
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
  const operatorKeyLock = new InProcessOperatorKeyLock(timeline);
  const service = new FinalizeIpoEscrowCampaignsService(repository, chain as never, logger, () => now, {
    operatorKeyLock,
    ...(options.nonceBlockTag === undefined ? {} : { nonceBlockTag: options.nonceBlockTag }),
  });
  return {
    chain,
    operatorKeyLock,
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
function singleContributor(options: { nonceBlockTag?: EscrowMintNonceBlockTag } = {}) {
  return harness({
    ...successfulCampaign({ tokenId: "1", contributions: { "0xInvestorA": 100n } }),
    candidates: [{ pivId: "piv_1", tokenId: "1" }],
    wallets: { "0xInvestorA": "account_a" },
    ...options,
  });
}

// An intent written before mint nonces were pinned: an attempt began at T0 and recorded no hash.
function legacyInterruptedAttempt() {
  const h = singleContributor();
  h.repository.seedIntent({ pivId: "piv_1", accountId: "account_a", walletAddress: "0xInvestorA", attemptedAt: T0 });
  return h;
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

  // Pins the current behaviour, not a guarantee: a sweep is taken to mean the
  // contributors were minted first, which only holds for sweeps this job did
  // itself (withdrawRaised is permissionless). See the swept check in the service.
  it("skips an already-swept campaign entirely, without telling a sweep by this job from one by anyone else", async () => {
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

    it("after the intent is written but before the mint is sent: resends under the same nonce on the next run, and mints exactly once", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("reject"); // the call never reaches the node

      const first = await h.run();

      expect(first.errors).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(0);
      const pinned = [...h.repository.intents.values()][0]!;
      expect(pinned).toMatchObject({ status: "sending", mintTxHash: null });
      expect(pinned.mintNonce).not.toBeNull();

      // No waiting: the attempt's nonce is unused and no mint log exists, so the mint is
      // resent under that nonce -- the chain cannot mine both if the first one did go out.
      h.advance(60_000);
      const next = await h.run();
      expect(next.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.mints[0]!.nonce).toBe(pinned.mintNonce);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect([...h.repository.intents.values()][0]).toMatchObject({
        status: "recorded",
        attempt: 2,
        mintNonce: pinned.mintNonce,
      });
    });

    it("writes the nonce to the intent before sending the mint, and sends the mint under it", async () => {
      const h = singleContributor();
      h.chain.consumeNonce(); // the operator has sent transactions before
      h.chain.consumeNonce();
      h.chain.authorizedHolders.add("0xinvestora:1");

      const summary = await h.run();

      expect(summary.errors).toEqual([]);
      expect(h.timeline.indexOf("repo:createEscrowMintIntent")).toBeLessThan(h.timeline.indexOf("chain:mint"));
      expect([...h.repository.intents.values()][0]!.mintNonce).toBe(2n);
      expect(h.chain.property.write.mint).toHaveBeenCalledWith(expect.anything(), { nonce: 2 });
    });

    it("does not mint twice when a mint whose hash was never seen is still pending, however long it takes", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("pending-then-reject"); // accepted by the node; the caller only sees a timeout

      const first = await h.run();
      expect(first.errors).toHaveLength(1);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "sending", mintTxHash: null });

      // Long past any time-based window, the original is still in the mempool. The resend
      // under the same nonce is refused by the node, so nothing new is pending.
      h.advance(10 * ESCROW_MINT_IN_FLIGHT_GRACE_MS);
      const stillPending = await h.run();
      expect(stillPending.errors).toHaveLength(1);
      expect(stillPending.errors[0]).toContain("replacement transaction underpriced");
      expect(h.chain.mints).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(0);

      // The original lands: the next run records it from its mint log.
      h.chain.mineNextPending();
      const landed = await h.run();
      expect(landed.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect(h.repository.recordedPositions[0]!.chainTxHash).toBe(h.chain.mints[0]!.hash);
    });

    it("starts a new attempt under a fresh nonce at once when the pinned nonce was used without a mint", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("reject");
      await h.run();
      const pinned = [...h.repository.intents.values()][0]!.mintNonce!;
      h.chain.consumeNonce(); // another operator transaction took that nonce

      const next = await h.run();

      expect(next.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.mints[0]!.nonce).toBe(pinned + 1n);
      expect([...h.repository.intents.values()][0]).toMatchObject({
        status: "recorded",
        attempt: 2,
        mintNonce: pinned + 1n,
      });
      expect(h.entries.some((e) => e.message.includes("nonce was used without a mint"))).toBe(true);
    });

    it("does not take a nonce as used until the block that used it is final", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("reject");
      await h.run();
      const pinned = [...h.repository.intents.values()][0]!.mintNonce!;
      h.chain.finalizedNonceCount = pinned; // finality has not caught up with the block below
      h.chain.consumeNonce();

      const notFinal = await h.run();

      // The attempt is not replaced with a fresh nonce on the strength of a block a reorg could
      // drop; the resend under the pinned one is refused as too low, and nothing is minted.
      expect(notFinal.errors).toHaveLength(1);
      expect(notFinal.errors[0]).toContain("nonce too low");
      expect(h.chain.mints).toHaveLength(0);

      h.chain.finalizedNonceCount = undefined; // final now
      const final = await h.run();
      expect(final.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.mints[0]!.nonce).toBe(pinned + 1n);
    });

    it("reads the confirmed nonce at the configured block tag", async () => {
      const h = singleContributor({ nonceBlockTag: "latest" });
      h.chain.mintModes.push("reject");
      await h.run();
      h.chain.finalizedNonceCount = [...h.repository.intents.values()][0]!.mintNonce!;
      h.chain.consumeNonce();

      const next = await h.run();

      expect(next.errors).toEqual([]);
      expect(h.chain.publicClient.getTransactionCount).toHaveBeenCalledWith(
        expect.objectContaining({ address: h.chain.operatorAddress, blockTag: "latest" }),
      );
      expect(h.chain.mints).toHaveLength(1);
    });

    it("does not mint again when the attempt's mint is on-chain but the wallet no longer holds it", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("mine-then-reject");
      await h.run();
      const mintHash = h.chain.mints[0]!.hash;
      h.chain.balances.set("0xinvestora:1", 0n); // burned, or force-transferred away, before this run

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain(`its mint transaction ${mintHash} is on-chain`);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("does not pick between two mint logs for an attempt with a pinned nonce", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("mine-then-reject");
      await h.run();
      h.chain.transferLogs.push({ ...h.chain.transferLogs[0]!, transactionHash: "0xsecond" });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("found 2 mint logs");
      expect(h.chain.mints).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("for an attempt written before nonces were pinned: waits exactly 30 minutes, and not a moment less", async () => {
      expect(ESCROW_MINT_IN_FLIGHT_GRACE_MS).toBe(30 * 60 * 1000);
      const h = legacyInterruptedAttempt();

      h.advance(30 * 60 * 1000 - 1);
      const justBefore = await h.run();
      expect(justBefore.errors).toHaveLength(1);
      expect(justBefore.errors[0]).toContain("may still be in flight");
      expect(justBefore.errors[0]).toContain("0xInvestorA");
      expect(h.chain.mints).toHaveLength(0);

      h.advance(1); // exactly 30 minutes after the attempt began
      const atWindow = await h.run();
      expect(atWindow.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "recorded", attempt: 2 });
    });

    it("pins a nonce when it restarts an attempt written before nonces were, and follows the nonce rules after", async () => {
      const h = legacyInterruptedAttempt();
      h.chain.mintModes.push("reject");

      h.advance(ESCROW_MINT_IN_FLIGHT_GRACE_MS);
      const restarted = await h.run(); // attempt 2 begins now and is rejected
      expect(restarted.errors).toHaveLength(1);
      const intent = [...h.repository.intents.values()][0]!;
      expect(intent).toMatchObject({ status: "sending", attempt: 2 });
      expect(intent.mintNonce).not.toBeNull();

      // Attempt 2 has a pinned nonce, so no 30 minute wait applies to it.
      const immediately = await h.run();
      expect(immediately.errors).toEqual([]);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.chain.mints[0]!.nonce).toBe(intent.mintNonce);
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "recorded", attempt: 3 });
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

    it.each([
      [10n, 0n],
      [32n, 0n],
      [33n, 1n],
    ])("with the chain head at block %s, starts the log search at block %s and never below zero", async (head, expected) => {
      const h = singleContributor();
      h.chain.blockNumber = head;
      h.chain.mintModes.push("mine-then-reject");

      await h.run();

      expect([...h.repository.intents.values()][0]).toMatchObject({ searchFromBlock: expected });
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

    it("does not record a position from the receipt of a different transaction that replaced the mint", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("replaced"); // waiting on the mint's hash resolves with the replacement's receipt

      const first = await h.run();

      const mintHash = h.chain.mints[0]!.hash;
      expect(first.errors).toHaveLength(1);
      expect(first.errors[0]).toContain(`mint transaction ${mintHash} was replaced`);
      expect(first.errors[0]).toContain(`${mintHash}-replacement`);
      expect(first.errors[0]).toContain("0xInvestorA");
      // Nothing the replacement did is evidence that this mint executed: no position, and no sweep.
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(0n);
      expect(h.repository.recordedPositions).toHaveLength(0);
      expect(h.chain.ipoEscrow.write.withdrawRaised).not.toHaveBeenCalled();
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "mint_sent", mintTxHash: mintHash });

      // The next run does not send another mint over it either: the recorded hash still has no receipt.
      const second = await h.run();

      expect(second.errors).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(0);
      expect(h.chain.ipoEscrow.write.withdrawRaised).not.toHaveBeenCalled();
    });

    it("accepts the receipt of the mint's own transaction regardless of the hash's letter case", async () => {
      const h = singleContributor();
      const original = h.chain.publicClient.waitForTransactionReceipt.getMockImplementation()!;
      h.chain.publicClient.waitForTransactionReceipt.mockImplementation(async (args: { hash: string }) => {
        const receipt = await original(args);
        return { ...receipt, transactionHash: receipt.transactionHash.toUpperCase().replace("0X", "0x") };
      });

      const summary = await h.run();

      expect(summary.errors).toEqual([]);
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

    it("authorizes the holder again before a replacement mint when the authorization is gone by then", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("revert");
      await h.run();
      expect(h.chain.property.write.authorizeHolder).toHaveBeenCalledTimes(1);
      h.chain.authorizedHolders.delete("0xinvestora:1"); // revoked between the attempts

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(h.chain.property.write.authorizeHolder).toHaveBeenCalledTimes(2);
      const authorizeOrder = h.chain.property.write.authorizeHolder.mock.invocationCallOrder;
      const mintOrder = h.chain.property.write.mint.mock.invocationCallOrder;
      expect(authorizeOrder[1]!).toBeLessThan(mintOrder[1]!);
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);
    });

    it("reports a receipt lookup that fails for any reason other than 'not found' instead of reading it as 'not mined'", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("pending");
      await h.run();
      h.chain.publicClient.getTransactionReceipt.mockRejectedValueOnce(new Error("RPC error: 503 service unavailable"));

      const second = await h.run();

      expect(second.errors).toHaveLength(1);
      expect(second.errors[0]).toContain("503 service unavailable");
      expect(second.errors[0]).not.toContain("has no receipt yet");
      expect(h.chain.mints).toHaveLength(1);
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

    it("does not pick between two mint logs that both match the contribution", async () => {
      const h = singleContributor();
      h.chain.seedUnrecordedMint("0xInvestorA", 1n, 100n);
      h.chain.transferLogs.push({ ...h.chain.transferLogs[0]!, transactionHash: "0xsecond" }); // same mint, seen twice
      expect(h.chain.balanceOf("0xInvestorA", 1n)).toBe(100n);

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("could not be found in the chain logs");
      expect(h.repository.recordedPositions).toHaveLength(0);
      expect(h.repository.intents.size).toBe(0);
    });

    it("leaves an on-chain mint to the other run when that run claimed the contributor first", async () => {
      const h = singleContributor();
      h.chain.seedUnrecordedMint("0xInvestorA", 1n, 100n);
      h.repository.interleaveBefore("createEscrowMintIntent", () => {
        h.repository.seedIntent({ pivId: "piv_1", accountId: "account_a", walletAddress: "0xInvestorA", attemptedAt: T0 });
      });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("another run already claimed the mint");
      expect(h.repository.recordedPositions).toHaveLength(0);
      expect(h.chain.property.write.mint).not.toHaveBeenCalled();
      expect([...h.repository.intents.values()][0]).toMatchObject({ status: "sending", mintTxHash: null });
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

    it.each([
      ["wallet", { walletAddress: "0xSomeoneElse" }],
      ["token id", { tokenId: "2" }],
      ["amount", { mintAmount: 101n }],
      ["token contract", { tokenContractAddress: "0xOTHERCONTRACT000000000000000000000000000" }],
    ])("does not send when the intent's %s contradicts the chain", async (_field, contradiction) => {
      const h = singleContributor();
      h.repository.seedIntent({ pivId: "piv_1", accountId: "account_a", ...contradiction });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("does not match the contribution now on-chain");
      expect(h.chain.mints).toHaveLength(0);
      expect(h.repository.recordedPositions).toHaveLength(0);
    });

    it("compares the intent's wallet and token contract regardless of address letter case", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("pending");
      await h.run(); // intent in mint_sent, mint pending
      h.chain.mineNextPending();
      const [intent] = [...h.repository.intents.values()];
      intent!.walletAddress = "0xinvestora"; // stored in another casing than the chain reports
      intent!.tokenContractAddress = PROPERTY_CONTRACT.toLowerCase();

      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect(h.chain.mints).toHaveLength(1);
    });

    it("does not mint when an intent is marked recorded but its position is missing", async () => {
      const h = singleContributor();
      h.repository.seedIntent({ pivId: "piv_1", accountId: "account_a", status: "recorded", mintTxHash: "0xold" });

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0]).toContain("is recorded but no position exists");
      expect(h.chain.mints).toHaveLength(0);
    });

    it("treats an intent that another run recorded between this run's position check and its intent read as done, not as an inconsistency", async () => {
      const h = singleContributor();
      h.repository.failNext("recordEscrowMintedPosition", "before"); // run 1 mints, saves the hash, dies before the position
      await h.run();
      expect(h.repository.recordedPositions).toHaveLength(0);

      // Run 2 finds no position, and then the other run records it before run 2 reads the intent.
      h.repository.interleaveBeforeIntentRead(async () => {
        const intent = [...h.repository.intents.values()][0]!;
        await h.repository.recordEscrowMintedPosition({
          escrowMintIntentId: intent.id,
          pivId: "piv_1",
          accountId: "account_a",
          walletAddress: "0xInvestorA",
          unitCount: "0.000100",
          costBasisEur: "0.000100",
          activatedAt: T0,
          tokenContractAddress: intent.tokenContractAddress,
          tokenId: "1",
          chainTxHash: intent.mintTxHash!,
        });
      });

      const loggedBeforeSecondRun = h.entries.length;
      const second = await h.run();

      expect(second.errors).toEqual([]);
      expect(h.entries.slice(loggedBeforeSecondRun).filter((e) => e.level === "error")).toEqual([]);
      expect(second.positionsMinted).toBe(0);
      expect(h.chain.mints).toHaveLength(1);
      expect(h.repository.recordedPositions).toHaveLength(1);
      // The rest of the campaign is not abandoned: the sweep still happens.
      expect(h.chain.ipoEscrow.write.withdrawRaised).toHaveBeenCalledTimes(1);
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

  describe("the operator-key lock (every chain write made with the operator key)", () => {
    // Records, for each write the service sends and each nonce read it makes,
    // whether the lock was held at that moment.
    function observeLock(h: ReturnType<typeof singleContributor>) {
      const seen: string[] = [];
      const wrap = (fn: { getMockImplementation: () => unknown; mockImplementation: (impl: never) => unknown }, name: string) => {
        const impl = fn.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
        fn.mockImplementation((async (...args: unknown[]) => {
          seen.push(`${name}:${h.operatorKeyLock.held ? "locked" : "unlocked"}`);
          return impl(...args);
        }) as never);
      };
      wrap(h.chain.ipoEscrow.write.finalize, "finalize");
      wrap(h.chain.ipoEscrow.write.withdrawRaised, "withdrawRaised");
      wrap(h.chain.property.write.authorizeHolder, "authorizeHolder");
      wrap(h.chain.property.write.mint, "mint");
      wrap(h.chain.publicClient.getTransactionCount, "getTransactionCount");
      wrap(h.chain.publicClient.waitForTransactionReceipt, "waitForReceipt");
      return seen;
    }

    it("sends authorizeHolder, reads the pending nonce and sends the mint with the lock held, and waits for receipts without it", async () => {
      const h = singleContributor();
      const seen = observeLock(h);

      const summary = await h.run();

      expect(summary.errors).toEqual([]);
      expect(seen).toEqual([
        "authorizeHolder:locked",
        "waitForReceipt:unlocked",
        "getTransactionCount:locked",
        "mint:locked",
        "waitForReceipt:unlocked",
        "withdrawRaised:locked",
        "waitForReceipt:unlocked",
      ]);
    });

    it("reads the nonce, writes the intent and sends the mint in one locked section, with the hash recorded after it", async () => {
      const h = singleContributor();

      await h.run();

      const section = h.timeline.slice(h.timeline.indexOf("repo:createEscrowMintIntent") - 1);
      expect(section.slice(0, 4)).toEqual(["lock:enter", "repo:createEscrowMintIntent", "chain:mint", "lock:exit"]);
      expect(section[4]).toBe("repo:recordEscrowMintSent");
    });

    it("sends finalize with the lock held, then waits for its receipt without it", async () => {
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
        contributors: new Map([["2", []]]),
        candidates: [{ pivId: "piv_2", tokenId: "2" }],
        wallets: {},
      });
      const seen: string[] = [];
      const finalize = h.chain.ipoEscrow.write.finalize.getMockImplementation()!;
      h.chain.ipoEscrow.write.finalize.mockImplementation(async (...args) => {
        seen.push(h.operatorKeyLock.held ? "finalize:locked" : "finalize:unlocked");
        return finalize(...args);
      });

      await h.run();

      expect(seen).toEqual(["finalize:locked"]);
      expect(h.operatorKeyLock.held).toBe(false);
    });

    it("releases the lock when a write throws, so the next writer is not blocked", async () => {
      const h = singleContributor();
      h.chain.mintModes.push("reject");

      const summary = await h.run();

      expect(summary.errors).toHaveLength(1);
      expect(h.operatorKeyLock.held).toBe(false);
      expect(h.timeline.filter((entry) => entry === "lock:enter")).toHaveLength(
        h.timeline.filter((entry) => entry === "lock:exit").length,
      );
    });
  });

  describe("recording the state of a campaign that is not Open (AD-286)", () => {
    const row = (pivId: string): Parameters<InMemorySettlementRepository["ipoEscrowCampaignObservations"]["set"]>[1] => ({
      pivId,
      tokenId: "1",
      escrowContractAddress: "0xescrow",
      targetAmount: 1n,
      deadlineAt: new Date("2026-10-01T00:00:00.000Z"),
      treasuryAddress: "0xtreasury",
      openTxHash: null,
      observedState: "open",
      observedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    it("moves the observation of a campaign it finds Successful, so the offering stops being ready", async () => {
      const h = singleContributor();
      h.repository.ipoEscrowCampaignObservations.set("piv_1", row("piv_1"));

      await h.run();

      expect(h.repository.campaignRefreshes).toEqual([{ pivId: "piv_1", state: "successful", observedAt: T0 }]);
      expect(h.repository.ipoEscrowCampaignObservations.get("piv_1")?.observedState).toBe("successful");
    });

    it("moves it to Failed after finalizing an underfunded campaign, and refreshes nothing while the campaign is still Open", async () => {
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
        contributors: new Map([["2", []]]),
        candidates: [{ pivId: "piv_2", tokenId: "2" }],
        wallets: {},
      });
      h.repository.ipoEscrowCampaignObservations.set("piv_2", row("piv_2"));

      await h.run();

      // One refresh only: the read before finalize() saw Open and recorded nothing.
      expect(h.repository.campaignRefreshes).toEqual([{ pivId: "piv_2", state: "failed", observedAt: T0 }]);
      expect(h.repository.ipoEscrowCampaignObservations.get("piv_2")?.observedState).toBe("failed");
    });

    it("also records a campaign that is already swept, which the run otherwise skips", async () => {
      const h = harness({
        ...successfulCampaign({ tokenId: "1", contributions: { "0xInvestorA": 100n }, swept: true }),
        candidates: [{ pivId: "piv_1", tokenId: "1" }],
        wallets: { "0xInvestorA": "account_a" },
      });
      h.repository.ipoEscrowCampaignObservations.set("piv_1", row("piv_1"));

      await h.run();

      expect(h.repository.ipoEscrowCampaignObservations.get("piv_1")?.observedState).toBe("successful");
      expect(h.chain.mints).toHaveLength(0);
    });

    it("does not create an observation for an offering that has none", async () => {
      const h = singleContributor();

      await h.run();

      expect(h.repository.ipoEscrowCampaignObservations.size).toBe(0);
    });

    it("never stops a mint because the status write failed, and logs it under a stable event name", async () => {
      const h = singleContributor();
      h.repository.ipoEscrowCampaignObservations.set("piv_1", row("piv_1"));
      h.repository.refreshFails = true;

      const summary = await h.run();

      expect(summary).toMatchObject({ errors: [], positionsMinted: 1 });
      expect(h.repository.recordedPositions).toHaveLength(1);
      expect(h.entries.filter((entry) => entry.fields.event === "settlement.ipo_escrow_campaign_observation_failed")).toHaveLength(1);
    });
  });
});
