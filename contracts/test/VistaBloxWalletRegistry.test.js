import { expect } from "chai";
import { network } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";

describe("VistaBloxWalletRegistry", function () {
  let ethers;
  let registry;
  let investorA;
  let investorB;

  before(async function () {
    ({ ethers } = await network.create());
    [, investorA, investorB] = await ethers.getSigners();
  });

  beforeEach(async function () {
    registry = await ethers.deployContract("VistaBloxWalletRegistry");
  });

  it("emits WalletRegistered with the caller's own address and the given commitment", async function () {
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("commitment-1"));

    await expect(registry.connect(investorA).register(commitment))
      .to.emit(registry, "WalletRegistered")
      .withArgs(investorA.address, commitment, anyValue);
  });

  it("is permissionless -- any address can register itself, with no admin or owner role", async function () {
    const commitmentA = ethers.keccak256(ethers.toUtf8Bytes("commitment-a"));
    const commitmentB = ethers.keccak256(ethers.toUtf8Bytes("commitment-b"));

    await expect(registry.connect(investorA).register(commitmentA)).to.not.revert(ethers);
    await expect(registry.connect(investorB).register(commitmentB)).to.not.revert(ethers);
  });

  it("always registers msg.sender, never an address passed as a parameter", async function () {
    // The function signature itself only accepts a commitment, not a
    // target address -- this test documents that guarantee via the event
    // rather than attempting to call a nonexistent overload.
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("commitment-self-only"));
    const tx = await registry.connect(investorB).register(commitment);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return registry.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed?.name === "WalletRegistered");

    expect(event?.args.wallet).to.equal(investorB.address);
    expect(event?.args.wallet).to.not.equal(investorA.address);
  });

  it("allows the same address to register again (address change, AD-241 step 10)", async function () {
    const firstCommitment = ethers.keccak256(ethers.toUtf8Bytes("initial-registration"));
    const secondCommitment = ethers.keccak256(ethers.toUtf8Bytes("later-change"));

    await registry.connect(investorA).register(firstCommitment);
    await expect(registry.connect(investorA).register(secondCommitment))
      .to.emit(registry, "WalletRegistered")
      .withArgs(investorA.address, secondCommitment, anyValue);
  });
});
