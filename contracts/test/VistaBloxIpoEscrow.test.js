import { expect } from "chai";
import { network } from "hardhat";

describe("VistaBloxIpoEscrow", function () {
  const TOKEN_ID = 1n;
  const TARGET = 1_000_000_000_000n; // 1,000,000 EURC at 6 decimals
  const WEEK = 7 * 24 * 60 * 60;

  let ethers;
  let networkHelpers;
  let admin;
  let campaignManager;
  let treasury;
  let investor1;
  let investor2;
  let stranger;
  let eurc;
  let escrow;
  let CAMPAIGN_MANAGER_ROLE;

  before(async function () {
    ({ ethers, networkHelpers } = await network.create());
    [admin, campaignManager, treasury, investor1, investor2, stranger] = await ethers.getSigners();
    eurc = await ethers.deployContract("MockEURC", [], admin);
  });

  beforeEach(async function () {
    escrow = await ethers.deployContract("VistaBloxIpoEscrow", [await eurc.getAddress()], admin);
    CAMPAIGN_MANAGER_ROLE = await escrow.CAMPAIGN_MANAGER_ROLE();
    await escrow.connect(admin).grantRole(CAMPAIGN_MANAGER_ROLE, campaignManager.address);
  });

  async function futureDeadline(offsetSeconds = WEEK) {
    const now = await networkHelpers.time.latest();
    return BigInt(now + offsetSeconds);
  }

  async function openDefaultCampaign(overrides = {}) {
    const deadline = overrides.deadline ?? (await futureDeadline());
    await escrow
      .connect(campaignManager)
      .openCampaign(
        overrides.tokenId ?? TOKEN_ID,
        overrides.target ?? TARGET,
        deadline,
        overrides.treasury ?? treasury.address,
      );
    return deadline;
  }

  async function fund(investor, amount) {
    await eurc.connect(admin).mint(investor.address, amount);
    await eurc.connect(investor).approve(await escrow.getAddress(), amount);
  }

  describe("deployment", function () {
    it("sets the EURC address and grants only DEFAULT_ADMIN_ROLE to the deployer", async function () {
      expect(await escrow.EURC()).to.equal(await eurc.getAddress());
      const defaultAdminRole = await escrow.DEFAULT_ADMIN_ROLE();
      expect(await escrow.hasRole(defaultAdminRole, admin.address)).to.be.true;
      expect(await escrow.hasRole(CAMPAIGN_MANAGER_ROLE, admin.address)).to.be.false;
    });
  });

  describe("openCampaign", function () {
    it("opens a campaign and emits CampaignOpened", async function () {
      const deadline = await futureDeadline();
      await expect(
        escrow.connect(campaignManager).openCampaign(TOKEN_ID, TARGET, deadline, treasury.address),
      )
        .to.emit(escrow, "CampaignOpened")
        .withArgs(TOKEN_ID, TARGET, deadline, treasury.address, campaignManager.address);

      const campaign = await escrow.campaignOf(TOKEN_ID);
      expect(campaign.targetAmount).to.equal(TARGET);
      expect(campaign.totalRaised).to.equal(0n);
      expect(campaign.deadline).to.equal(deadline);
      expect(campaign.treasury).to.equal(treasury.address);
      expect(campaign.state).to.equal(1n); // Open
      expect(campaign.swept).to.be.false;
    });

    it("reverts if the campaign is already opened", async function () {
      await openDefaultCampaign();
      await expect(openDefaultCampaign()).to.be.revertedWithCustomError(escrow, "CampaignAlreadyOpened");
    });

    it("reverts on a zero target, zero treasury, or past/current deadline", async function () {
      const deadline = await futureDeadline();
      await expect(
        escrow.connect(campaignManager).openCampaign(TOKEN_ID, 0n, deadline, treasury.address),
      ).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(
        escrow.connect(campaignManager).openCampaign(TOKEN_ID, TARGET, deadline, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
      const past = await networkHelpers.time.latest();
      await expect(
        escrow.connect(campaignManager).openCampaign(TOKEN_ID, TARGET, past, treasury.address),
      ).to.be.revertedWithCustomError(escrow, "InvalidDeadline");
    });

    it("reverts when called by an account without CAMPAIGN_MANAGER_ROLE", async function () {
      const deadline = await futureDeadline();
      await expect(
        escrow.connect(stranger).openCampaign(TOKEN_ID, TARGET, deadline, treasury.address),
      ).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
    });
  });

  describe("updateTreasury / extendDeadline", function () {
    it("updates the treasury address while open", async function () {
      await openDefaultCampaign();
      await expect(escrow.connect(campaignManager).updateTreasury(TOKEN_ID, investor2.address))
        .to.emit(escrow, "TreasuryUpdated")
        .withArgs(TOKEN_ID, investor2.address, campaignManager.address);
      expect((await escrow.campaignOf(TOKEN_ID)).treasury).to.equal(investor2.address);
    });

    it("extends the deadline while open", async function () {
      const deadline = await openDefaultCampaign();
      const newDeadline = deadline + BigInt(WEEK);
      await expect(escrow.connect(campaignManager).extendDeadline(TOKEN_ID, newDeadline))
        .to.emit(escrow, "DeadlineExtended")
        .withArgs(TOKEN_ID, newDeadline, campaignManager.address);
      expect((await escrow.campaignOf(TOKEN_ID)).deadline).to.equal(newDeadline);
    });

    it("reverts both once the campaign is no longer open", async function () {
      const deadline = await openDefaultCampaign();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await escrow.finalize(TOKEN_ID);
      await expect(
        escrow.connect(campaignManager).updateTreasury(TOKEN_ID, investor2.address),
      ).to.be.revertedWithCustomError(escrow, "CampaignNotOpen");
      await expect(
        escrow.connect(campaignManager).extendDeadline(TOKEN_ID, deadline + BigInt(WEEK)),
      ).to.be.revertedWithCustomError(escrow, "CampaignNotOpen");
    });

    it("reverts when called by an account without CAMPAIGN_MANAGER_ROLE", async function () {
      await openDefaultCampaign();
      await expect(
        escrow.connect(stranger).updateTreasury(TOKEN_ID, investor2.address),
      ).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
      await expect(
        escrow.connect(stranger).extendDeadline(TOKEN_ID, (await futureDeadline()) + BigInt(WEEK)),
      ).to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
    });
  });

  describe("contribute", function () {
    it("reverts when the campaign was never opened", async function () {
      await fund(investor1, 100n);
      await expect(escrow.connect(investor1).contribute(TOKEN_ID, 100n)).to.be.revertedWithCustomError(
        escrow,
        "CampaignNotOpen",
      );
    });

    it("pulls EURC, tracks the contribution, and emits Contributed", async function () {
      await openDefaultCampaign();
      const amount = 250_000_000_000n;
      await fund(investor1, amount);

      await expect(escrow.connect(investor1).contribute(TOKEN_ID, amount))
        .to.emit(escrow, "Contributed")
        .withArgs(TOKEN_ID, investor1.address, amount, amount);

      expect(await escrow.contributionOf(TOKEN_ID, investor1.address)).to.equal(amount);
      expect((await escrow.campaignOf(TOKEN_ID)).totalRaised).to.equal(amount);
      expect(await eurc.balanceOf(await escrow.getAddress())).to.equal(amount);
    });

    it("accumulates repeat contributions from the same investor", async function () {
      await openDefaultCampaign();
      await fund(investor1, 300_000_000_000n);
      await escrow.connect(investor1).contribute(TOKEN_ID, 100_000_000_000n);
      await escrow.connect(investor1).contribute(TOKEN_ID, 200_000_000_000n);
      expect(await escrow.contributionOf(TOKEN_ID, investor1.address)).to.equal(300_000_000_000n);
    });

    it("tracks independent contributors separately", async function () {
      await openDefaultCampaign();
      await fund(investor1, 100_000_000_000n);
      await fund(investor2, 150_000_000_000n);
      await escrow.connect(investor1).contribute(TOKEN_ID, 100_000_000_000n);
      await escrow.connect(investor2).contribute(TOKEN_ID, 150_000_000_000n);
      expect(await escrow.contributionOf(TOKEN_ID, investor1.address)).to.equal(100_000_000_000n);
      expect(await escrow.contributionOf(TOKEN_ID, investor2.address)).to.equal(150_000_000_000n);
      expect((await escrow.campaignOf(TOKEN_ID)).totalRaised).to.equal(250_000_000_000n);
    });

    it("lists each distinct contributor once via contributorsOf, in first-contribution order", async function () {
      await openDefaultCampaign();
      await fund(investor1, 200_000_000_000n);
      await fund(investor2, 150_000_000_000n);
      await escrow.connect(investor1).contribute(TOKEN_ID, 100_000_000_000n);
      await escrow.connect(investor2).contribute(TOKEN_ID, 150_000_000_000n);
      await escrow.connect(investor1).contribute(TOKEN_ID, 100_000_000_000n); // repeat contributor

      expect(await escrow.contributorsOf(TOKEN_ID)).to.deep.equal([investor1.address, investor2.address]);
    });

    it("returns an empty contributor list for a campaign with no contributions", async function () {
      await openDefaultCampaign();
      expect(await escrow.contributorsOf(TOKEN_ID)).to.deep.equal([]);
    });

    it("reverts on zero amount", async function () {
      await openDefaultCampaign();
      await expect(escrow.connect(investor1).contribute(TOKEN_ID, 0n)).to.be.revertedWithCustomError(
        escrow,
        "ZeroAmount",
      );
    });

    it("reverts once the contribution would exceed the target", async function () {
      await openDefaultCampaign();
      await fund(investor1, TARGET + 1n);
      await expect(escrow.connect(investor1).contribute(TOKEN_ID, TARGET + 1n))
        .to.be.revertedWithCustomError(escrow, "TargetExceeded")
        .withArgs(TOKEN_ID, TARGET + 1n, TARGET);
    });

    it("reverts once the deadline has passed", async function () {
      const deadline = await openDefaultCampaign();
      await fund(investor1, 100n);
      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(escrow.connect(investor1).contribute(TOKEN_ID, 100n)).to.be.revertedWithCustomError(
        escrow,
        "DeadlineAlreadyPassed",
      );
    });
  });

  describe("finalize", function () {
    it("reverts before the deadline is reached", async function () {
      await openDefaultCampaign();
      await expect(escrow.finalize(TOKEN_ID)).to.be.revertedWithCustomError(escrow, "DeadlineNotReached");
    });

    it("resolves Successful when the target was met", async function () {
      const deadline = await openDefaultCampaign();
      await fund(investor1, TARGET);
      await escrow.connect(investor1).contribute(TOKEN_ID, TARGET);
      await networkHelpers.time.increaseTo(deadline + 1n);

      await expect(escrow.finalize(TOKEN_ID)).to.emit(escrow, "CampaignFinalized").withArgs(TOKEN_ID, true, TARGET);
      expect((await escrow.campaignOf(TOKEN_ID)).state).to.equal(2n); // Successful
    });

    it("resolves Failed when the target was not met", async function () {
      const deadline = await openDefaultCampaign();
      await fund(investor1, 1_000_000n);
      await escrow.connect(investor1).contribute(TOKEN_ID, 1_000_000n);
      await networkHelpers.time.increaseTo(deadline + 1n);

      await expect(escrow.finalize(TOKEN_ID))
        .to.emit(escrow, "CampaignFinalized")
        .withArgs(TOKEN_ID, false, 1_000_000n);
      expect((await escrow.campaignOf(TOKEN_ID)).state).to.equal(3n); // Failed
    });

    it("reverts on a second finalize call", async function () {
      const deadline = await openDefaultCampaign();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await escrow.finalize(TOKEN_ID);
      await expect(escrow.finalize(TOKEN_ID)).to.be.revertedWithCustomError(escrow, "CampaignNotOpen");
    });

    it("is permissionless", async function () {
      const deadline = await openDefaultCampaign();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(escrow.connect(stranger).finalize(TOKEN_ID)).to.not.revert(ethers);
    });
  });

  describe("withdrawRaised (success path)", function () {
    async function successfulCampaign() {
      const deadline = await openDefaultCampaign();
      await fund(investor1, TARGET);
      await escrow.connect(investor1).contribute(TOKEN_ID, TARGET);
      await networkHelpers.time.increaseTo(deadline + 1n);
      await escrow.finalize(TOKEN_ID);
    }

    it("sweeps the full raised balance to treasury, permissionlessly", async function () {
      await successfulCampaign();
      const before = await eurc.balanceOf(treasury.address);

      await expect(escrow.connect(stranger).withdrawRaised(TOKEN_ID))
        .to.emit(escrow, "RaisedWithdrawn")
        .withArgs(TOKEN_ID, treasury.address, TARGET);

      expect(await eurc.balanceOf(treasury.address)).to.equal(before + TARGET);
      expect(await eurc.balanceOf(await escrow.getAddress())).to.equal(0n);
      expect((await escrow.campaignOf(TOKEN_ID)).swept).to.be.true;
    });

    it("reverts if the campaign was not successful", async function () {
      const deadline = await openDefaultCampaign();
      await networkHelpers.time.increaseTo(deadline + 1n);
      await escrow.finalize(TOKEN_ID); // underfunded -> Failed
      await expect(escrow.withdrawRaised(TOKEN_ID)).to.be.revertedWithCustomError(
        escrow,
        "CampaignNotSuccessful",
      );
    });

    it("reverts on a second sweep", async function () {
      await successfulCampaign();
      await escrow.withdrawRaised(TOKEN_ID);
      await expect(escrow.withdrawRaised(TOKEN_ID)).to.be.revertedWithCustomError(escrow, "AlreadySwept");
    });
  });

  describe("withdraw (failure path)", function () {
    async function failedCampaignWithContribution(investor, amount) {
      const deadline = await openDefaultCampaign();
      await fund(investor, amount);
      await escrow.connect(investor).contribute(TOKEN_ID, amount);
      await networkHelpers.time.increaseTo(deadline + 1n);
      await escrow.finalize(TOKEN_ID); // underfunded -> Failed
    }

    it("independently refunds each contributor their own contribution", async function () {
      const amount1 = 1_000_000n;
      const deadline = await openDefaultCampaign();
      await fund(investor1, amount1);
      await escrow.connect(investor1).contribute(TOKEN_ID, amount1);
      const amount2 = 2_000_000n;
      await fund(investor2, amount2);
      await escrow.connect(investor2).contribute(TOKEN_ID, amount2);
      await networkHelpers.time.increaseTo(deadline + 1n);
      await escrow.finalize(TOKEN_ID);

      const before1 = await eurc.balanceOf(investor1.address);
      await expect(escrow.connect(investor1).withdraw(TOKEN_ID))
        .to.emit(escrow, "ContributionWithdrawn")
        .withArgs(TOKEN_ID, investor1.address, amount1);
      expect(await eurc.balanceOf(investor1.address)).to.equal(before1 + amount1);
      expect(await escrow.contributionOf(TOKEN_ID, investor1.address)).to.equal(0n);

      // investor2's claim is untouched by investor1's withdrawal
      expect(await escrow.contributionOf(TOKEN_ID, investor2.address)).to.equal(amount2);
    });

    it("reverts if the campaign was not Failed", async function () {
      const deadline = await openDefaultCampaign();
      await fund(investor1, TARGET);
      await escrow.connect(investor1).contribute(TOKEN_ID, TARGET);
      await networkHelpers.time.increaseTo(deadline + 1n);
      await escrow.finalize(TOKEN_ID); // fully funded -> Successful
      await expect(escrow.connect(investor1).withdraw(TOKEN_ID)).to.be.revertedWithCustomError(
        escrow,
        "CampaignNotFailed",
      );
    });

    it("reverts if the caller has no contribution", async function () {
      await failedCampaignWithContribution(investor1, 1_000_000n);
      await expect(escrow.connect(stranger).withdraw(TOKEN_ID)).to.be.revertedWithCustomError(
        escrow,
        "NoContribution",
      );
    });

    it("reverts on a second withdrawal by the same contributor", async function () {
      await failedCampaignWithContribution(investor1, 1_000_000n);
      await escrow.connect(investor1).withdraw(TOKEN_ID);
      await expect(escrow.connect(investor1).withdraw(TOKEN_ID)).to.be.revertedWithCustomError(
        escrow,
        "NoContribution",
      );
    });
  });

  describe("pause", function () {
    it("blocks contribute, finalize, withdrawRaised, and withdraw while paused", async function () {
      const deadline = await openDefaultCampaign();
      await fund(investor1, 1_000_000n);

      await escrow.connect(admin).pause();

      await expect(escrow.connect(investor1).contribute(TOKEN_ID, 1_000_000n)).to.be.revertedWithCustomError(
        escrow,
        "EnforcedPause",
      );

      await networkHelpers.time.increaseTo(deadline + 1n);
      await expect(escrow.finalize(TOKEN_ID)).to.be.revertedWithCustomError(escrow, "EnforcedPause");

      await escrow.connect(admin).unpause();
      await escrow.finalize(TOKEN_ID);
    });

    it("reverts when called by an account without DEFAULT_ADMIN_ROLE", async function () {
      await expect(escrow.connect(stranger).pause()).to.be.revertedWithCustomError(
        escrow,
        "AccessControlUnauthorizedAccount",
      );
    });
  });
});
