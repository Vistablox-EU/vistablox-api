import { expect } from "chai";
import { network } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-ethers-chai-matchers/withArgs";

// Verifies the smart-account migration's core architectural claim: that
// VistaBloxWalletRegistry needs zero changes when a device's smart account
// (an ERC-4337 CoinbaseSmartWallet) calls register() via its own
// execute(target, value, data), instead of a plain EOA calling register()
// directly. Under ordinary Solidity call semantics, register() sees
// msg.sender as whichever contract (or EOA) called it directly -- so a call
// forwarded through a smart account's execute() reaches the registry with
// msg.sender = the smart account's own address, never the EOA that
// originally signed the outer transaction. MockSmartAccountCaller
// (contracts/mocks/MockSmartAccountCaller.sol) stands in for
// CoinbaseSmartWallet.execute() for exactly this forwarding shape -- see
// its doc comment for what it deliberately does not model.
describe("VistaBloxWalletRegistry (smart-account caller)", function () {
  let ethers;
  let registry;
  let mockSmartAccount;
  let eoaSigner;

  before(async function () {
    ({ ethers } = await network.create());
    [, eoaSigner] = await ethers.getSigners();
  });

  beforeEach(async function () {
    registry = await ethers.deployContract("VistaBloxWalletRegistry");
    mockSmartAccount = await ethers.deployContract("MockSmartAccountCaller");
  });

  it("registers the smart account's own address, not the EOA that sent the outer transaction", async function () {
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("smart-account-commitment"));
    const registryAddress = await registry.getAddress();
    const mockSmartAccountAddress = await mockSmartAccount.getAddress();
    const registerCalldata = registry.interface.encodeFunctionData("register", [commitment]);

    // Confirm mockSmartAccount is genuinely a contract address (has code),
    // not merely "some other address" -- that's the actual thing under
    // test, not just "a different address than the EOA".
    expect(await ethers.provider.getCode(mockSmartAccountAddress)).to.not.equal("0x");

    await expect(
      mockSmartAccount.connect(eoaSigner).execute(registryAddress, 0, registerCalldata),
    )
      .to.emit(registry, "WalletRegistered")
      .withArgs(mockSmartAccountAddress, commitment, anyValue);

    // Re-confirm via the raw receipt too: the event's wallet arg must be
    // the smart account's own address, and must NOT be the EOA that
    // signed and sent the outer execute() transaction.
    const tx = await mockSmartAccount
      .connect(eoaSigner)
      .execute(registryAddress, 0, registry.interface.encodeFunctionData("register", [
        ethers.keccak256(ethers.toUtf8Bytes("smart-account-commitment-2")),
      ]));
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

    expect(event?.args.wallet).to.equal(mockSmartAccountAddress);
    expect(event?.args.wallet).to.not.equal(eoaSigner.address);
  });

  it("still registers a direct EOA call identically to the existing (pre-smart-account) path", async function () {
    const commitment = ethers.keccak256(ethers.toUtf8Bytes("eoa-direct-commitment"));

    await expect(registry.connect(eoaSigner).register(commitment))
      .to.emit(registry, "WalletRegistered")
      .withArgs(eoaSigner.address, commitment, anyValue);
  });
});
